import { readFileSync, readdirSync } from "node:fs";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { organizations, paymentMethods, taxRules } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  answerPayments,
  answerTaxes,
  firstUnansweredHref,
  loadMoneyAnswers,
  profitBeforeTaxes,
} from "@/lib/money-answers";
import { loadMonthSetup } from "@/lib/onboarding";
import { adminDb, resetDatabase } from "../helpers/database";
import { createOrganization, createUser } from "../helpers/factories";

/**
 * «Как вы платите налоги?» and «Как платят клиенты?» against real rows.
 *
 * A question is answered by a rule that exists — ended or archived included —
 * or by the stored moment somebody said «нет». Both halves are facts about what
 * the queries filter and what the migration's backfill matches, which is why
 * they are asserted on a real database.
 */

/** The data half of migration 0062, run again on fixtures it never saw. */
function backfillStatements(): string[] {
  const file = readdirSync("drizzle").find((name) => name.startsWith("0062_"));
  if (!file) throw new Error("migration 0062 is missing");
  const updates = readFileSync(`drizzle/${file}`, "utf8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.includes("UPDATE"));
  if (updates.length !== 2) throw new Error("migration 0062 should carry two backfills");
  return updates;
}

const LONG_AGO = new Date("2025-01-01T00:00:00.000Z");

describe("the taxes and payments questions", () => {
  let organizationId: string;
  let userId: string;
  let actor: { organizationId: string; userId: string };

  const answers = () => withTenant(organizationId, (tx) => loadMoneyAnswers(tx, organizationId));
  const step = async (key: "taxes" | "payments") => {
    const { steps } = await withTenant(organizationId, (tx) =>
      loadMonthSetup(tx, { month: "2026-03", currency: "MDL", organizationId }),
    );
    return steps.find((candidate) => candidate.key === key)!;
  };

  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
    organizationId = (await createOrganization({ ownerId: userId })).id;
    actor = { organizationId, userId };
  });

  it("starts with neither answered, and the report before both", async () => {
    const result = await answers();

    expect(result).toEqual({ taxes: false, payments: false });
    expect(profitBeforeTaxes(result)).toBe(true);
    expect(firstUnansweredHref(result)).toBe("/app/expenses#taxes");
    expect(await step("taxes")).toEqual({ key: "taxes", done: false, href: "/app/expenses#taxes" });
    expect(await step("payments")).toEqual({ key: "payments", done: false, href: "/app/expenses#payments" });
  });

  it("points at payments once taxes are answered, and at nothing once both are", () => {
    expect(firstUnansweredHref({ taxes: true, payments: false })).toBe("/app/expenses#payments");
    expect(profitBeforeTaxes({ taxes: true, payments: false })).toBe(true);
    expect(profitBeforeTaxes({ taxes: false, payments: true })).toBe(true);
    expect(firstUnansweredHref({ taxes: true, payments: true })).toBeNull();
    expect(profitBeforeTaxes({ taxes: true, payments: true })).toBe(false);
  });

  describe("taxes", () => {
    it("counts «не плачу с визита» as an answer, and writes no rule for it", async () => {
      const result = await withTenant(organizationId, (tx) => answerTaxes(tx, actor, { answer: "none" }, "req"));

      expect(result).toEqual({ ok: true });
      expect((await answers()).taxes).toBe(true);
      expect((await step("taxes")).done).toBe(true);
      expect(await adminDb.select().from(taxRules).where(eq(taxRules.organizationId, organizationId))).toEqual([]);
      const [row] = await adminDb
        .select({ at: organizations.taxesAnsweredAt })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      expect(row.at).toBeInstanceOf(Date);
    });

    it("writes a rate as the same rule «Налоги с визита» keeps", async () => {
      await withTenant(organizationId, (tx) =>
        answerTaxes(tx, actor, { answer: "turnover", basisPoints: 400 }, "req"),
      );

      const rules = await adminDb.select().from(taxRules).where(eq(taxRules.organizationId, organizationId));
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ kind: "turnover", basisPoints: 400, remittable: true, activeTo: null });
      expect((await step("taxes")).done).toBe(true);
    });

    it("is answered by a rule entered elsewhere, even one that has ended", async () => {
      await adminDb.insert(taxRules).values({
        organizationId,
        kind: "vat",
        basisPoints: 2_000,
        activeFrom: LONG_AGO,
        activeTo: new Date("2025-06-01T00:00:00.000Z"),
      });

      expect((await answers()).taxes).toBe(true);
      expect((await step("taxes")).done).toBe(true);
    });

    it("is not answered by payroll contributions, which are another question", async () => {
      await adminDb.insert(taxRules).values({ organizationId, kind: "payroll", basisPoints: 2_400, activeFrom: LONG_AGO });

      expect((await answers()).taxes).toBe(false);
    });

    it("refuses a second answer instead of contradicting the first", async () => {
      await adminDb.insert(taxRules).values({ organizationId, kind: "vat", basisPoints: 2_000, activeFrom: LONG_AGO });

      const result = await withTenant(organizationId, (tx) => answerTaxes(tx, actor, { answer: "none" }, "req"));

      expect(result).toEqual({ ok: false, reason: "already_answered" });
      const [row] = await adminDb
        .select({ at: organizations.taxesAnsweredAt })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      expect(row.at).toBeNull();
    });

    it("is not answered by another studio's rule", async () => {
      const other = await createOrganization({ ownerId: (await createUser()).id });
      await adminDb.insert(taxRules).values({ organizationId: other.id, kind: "vat", basisPoints: 2_000 });
      await adminDb.insert(paymentMethods).values({ organizationId: other.id, name: "Карта", kind: "card" });

      expect(await answers()).toEqual({ taxes: false, payments: false });
    });
  });

  describe("payments", () => {
    it("counts «только наличные» as an answer: one cash method, the default", async () => {
      const result = await withTenant(organizationId, (tx) =>
        answerPayments(tx, actor, { methods: ["cash"], cardBasisPoints: null, defaultKind: "cash" }, "req"),
      );

      expect(result).toEqual({ ok: true });
      const methods = await adminDb.select().from(paymentMethods).where(eq(paymentMethods.organizationId, organizationId));
      expect(methods).toHaveLength(1);
      expect(methods[0]).toMatchObject({ name: "Наличные", kind: "cash", commissionBasisPoints: 0, isDefault: true });
      expect((await step("payments")).done).toBe(true);
    });

    it("writes every method chosen, the bank's rate on card alone, and the usual one as default", async () => {
      await withTenant(organizationId, (tx) =>
        answerPayments(
          tx,
          actor,
          { methods: ["cash", "card", "transfer"], cardBasisPoints: 220, defaultKind: "card" },
          "req",
        ),
      );

      const methods = await adminDb
        .select({ kind: paymentMethods.kind, rate: paymentMethods.commissionBasisPoints, isDefault: paymentMethods.isDefault })
        .from(paymentMethods)
        .where(eq(paymentMethods.organizationId, organizationId));
      expect(new Map(methods.map((method) => [method.kind, method]))).toEqual(
        new Map([
          ["cash", { kind: "cash", rate: 0, isDefault: false }],
          ["card", { kind: "card", rate: 220, isDefault: true }],
          ["transfer", { kind: "transfer", rate: 0, isDefault: false }],
        ]),
      );
    });

    it("names the methods in the studio's own language", async () => {
      await adminDb.update(organizations).set({ locale: "ro" }).where(eq(organizations.id, organizationId));

      await withTenant(organizationId, (tx) =>
        answerPayments(tx, actor, { methods: ["transfer"], cardBasisPoints: null, defaultKind: "transfer" }, "req"),
      );

      const [method] = await adminDb.select().from(paymentMethods).where(eq(paymentMethods.organizationId, organizationId));
      expect(method.name).toBe("Transfer");
    });

    it("is answered by a method entered elsewhere, even an archived one, and refuses a second answer", async () => {
      await adminDb
        .insert(paymentMethods)
        .values({ organizationId, name: "Maib", kind: "card", archivedAt: LONG_AGO });

      expect((await answers()).payments).toBe(true);
      const result = await withTenant(organizationId, (tx) =>
        answerPayments(tx, actor, { methods: ["cash"], cardBasisPoints: null, defaultKind: "cash" }, "req"),
      );
      expect(result).toEqual({ ok: false, reason: "already_answered" });
      const live = await adminDb
        .select()
        .from(paymentMethods)
        .where(and(eq(paymentMethods.organizationId, organizationId), isNull(paymentMethods.archivedAt)));
      expect(live).toEqual([]);
    });
  });
});

describe("the backfill of migration 0062", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("marks as answered exactly the studios that wrote a rule, at the first rule's creation", async () => {
    const userId = (await createUser()).id;
    const organization = async () => (await createOrganization({ ownerId: userId })).id;

    const withVat = await organization();
    const first = new Date("2025-02-01T10:00:00.000Z");
    await adminDb.insert(taxRules).values([
      { organizationId: withVat, kind: "vat", basisPoints: 2_000, createdAt: new Date("2025-05-01T10:00:00.000Z") },
      { organizationId: withVat, kind: "turnover", basisPoints: 400, createdAt: first },
    ]);

    const withEndedTurnover = await organization();
    await adminDb.insert(taxRules).values({
      organizationId: withEndedTurnover,
      kind: "turnover",
      basisPoints: 400,
      activeFrom: LONG_AGO,
      activeTo: new Date("2025-06-01T00:00:00.000Z"),
    });

    const withPayrollOnly = await organization();
    await adminDb.insert(taxRules).values({ organizationId: withPayrollOnly, kind: "payroll", basisPoints: 2_400 });

    const withArchivedTerminal = await organization();
    const terminalCreated = new Date("2025-03-01T10:00:00.000Z");
    await adminDb.insert(paymentMethods).values({
      organizationId: withArchivedTerminal,
      name: "Maib",
      kind: "card",
      archivedAt: LONG_AGO,
      createdAt: terminalCreated,
    });

    const untouched = await organization();

    for (const statement of backfillStatements()) await adminDb.execute(sql.raw(statement));

    const rows = await adminDb
      .select({ id: organizations.id, taxes: organizations.taxesAnsweredAt, payments: organizations.paymentsAnsweredAt })
      .from(organizations)
      .where(inArray(organizations.id, [withVat, withEndedTurnover, withPayrollOnly, withArchivedTerminal, untouched]));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    expect(byId[withVat].taxes?.toISOString()).toBe(first.toISOString());
    expect(byId[withVat].payments).toBeNull();
    expect(byId[withEndedTurnover].taxes).toBeInstanceOf(Date);
    expect(byId[withPayrollOnly].taxes).toBeNull();
    expect(byId[withArchivedTerminal].payments?.toISOString()).toBe(terminalCreated.toISOString());
    expect(byId[withArchivedTerminal].taxes).toBeNull();
    expect(byId[untouched]).toEqual({ id: untouched, taxes: null, payments: null });
  });

  it("leaves an answer already given where it was", async () => {
    const organizationId = (await createOrganization({ ownerId: (await createUser()).id })).id;
    const given = new Date("2026-01-10T09:00:00.000Z");
    await adminDb.update(organizations).set({ taxesAnsweredAt: given }).where(eq(organizations.id, organizationId));
    await adminDb.insert(taxRules).values({ organizationId, kind: "vat", basisPoints: 2_000, createdAt: LONG_AGO });

    for (const statement of backfillStatements()) await adminDb.execute(sql.raw(statement));

    const [row] = await adminDb
      .select({ at: organizations.taxesAnsweredAt })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(row.at?.toISOString()).toBe(given.toISOString());
  });
});
