import { readFileSync, readdirSync } from "node:fs";

import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { expenses, laborCostRules, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { basicPL } from "@/domain/basic-pl";
import { loadPeriodPL } from "@/lib/period";
import { recordCompletedVisit } from "@/lib/visit-service";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * «Подробная финансовая аналитика» against real rows.
 *
 * Two promises the switch is built on, and both are about organizations that
 * exist already. The backfill turns it on for exactly the studios that use the
 * lines the plain view leaves out, so nobody opens their report to find a line
 * gone; and no figure of any report moves, whichever way it is set — before the
 * migration, after it, or after the owner flips it.
 */

/** The data half of the migration, run again on fixtures the migration never saw. */
function backfillStatement(): string {
  const file = readdirSync("drizzle").find((name) => name.startsWith("0061_"));
  if (!file) throw new Error("migration 0061 is missing");
  const statements = readFileSync(`drizzle/${file}`, "utf8").split("--> statement-breakpoint");
  const update = statements.find((statement) => statement.includes("UPDATE"));
  if (!update) throw new Error("migration 0061 carries no backfill");
  return update;
}

const CATALOGUE_FROM = new Date("2025-01-01T00:00:00.000Z");

async function flags(ids: readonly string[]) {
  const rows = await adminDb
    .select({ id: organizations.id, detailedAnalytics: organizations.detailedAnalytics })
    .from(organizations)
    .where(inArray(organizations.id, [...ids]));
  return Object.fromEntries(rows.map((row) => [row.id, row.detailedAnalytics]));
}

describe("detailed analytics for organizations that exist", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("is turned on by the migration exactly where the detailed lines are in use", async () => {
    const userId = (await createUser()).id;
    const organization = async () => (await createOrganization({ ownerId: userId })).id;

    const withReserve = await organization();
    await adminDb.update(organizations).set({ withdrawalReserveMinor: 100_000 }).where(eq(organizations.id, withReserve));

    // A wage for the owner's own work, even one that has since ended.
    const withOwnerWage = await organization();
    await adminDb.insert(laborCostRules).values({
      organizationId: withOwnerWage,
      recipient: "owner",
      basis: "fixed_monthly",
      amountMinor: 1_500_000,
      activeFrom: CATALOGUE_FROM,
      activeTo: new Date("2025-06-01T00:00:00.000Z"),
    });

    // An owner who takes visits at a price: the report adds that back.
    const withPricedOwner = await organization();
    const owner = await createSpecialist(withPricedOwner, { isPrincipal: true });
    await createCommissionRule(withPricedOwner, owner.id, { basisPoints: 4_000, activeFrom: CATALOGUE_FROM });

    const withFixedOwner = await organization();
    const fixedOwner = await createSpecialist(withFixedOwner, { isPrincipal: true });
    await createCommissionRule(withFixedOwner, fixedOwner.id, {
      type: "fixed",
      basisPoints: null,
      fixedAmountMinor: 5_000,
      activeFrom: CATALOGUE_FROM,
    });

    // Nothing to lose: an owner at zero, and a studio whose only rate is a hired master's.
    const withZeroOwner = await organization();
    const zeroOwner = await createSpecialist(withZeroOwner, { isPrincipal: true });
    await createCommissionRule(withZeroOwner, zeroOwner.id, { basisPoints: 0, activeFrom: CATALOGUE_FROM });

    const withHiredMaster = await organization();
    const hired = await createSpecialist(withHiredMaster);
    await createCommissionRule(withHiredMaster, hired.id, { basisPoints: 4_000, activeFrom: CATALOGUE_FROM });

    const untouched = await organization();

    const all = [
      withReserve,
      withOwnerWage,
      withPricedOwner,
      withFixedOwner,
      withZeroOwner,
      withHiredMaster,
      untouched,
    ];
    // Everybody starts where the column's default puts them.
    expect(Object.values(await flags(all))).toEqual(all.map(() => false));

    await adminDb.execute(sql.raw(backfillStatement()));

    expect(await flags(all)).toEqual({
      [withReserve]: true,
      [withOwnerWage]: true,
      [withPricedOwner]: true,
      [withFixedOwner]: true,
      [withZeroOwner]: false,
      [withHiredMaster]: false,
      [untouched]: false,
    });
  });

  it("moves no figure of the month, before the migration, after it, or flipped by hand", async () => {
    const userId = (await createUser()).id;
    const organizationId = (await createOrganization({ ownerId: userId })).id;
    const owner = await createSpecialist(organizationId, { name: "Владелица", isPrincipal: true });
    const hired = await createSpecialist(organizationId, { name: "Мастер" });
    for (const person of [owner, hired]) {
      await createCommissionRule(organizationId, person.id, { basisPoints: 4_000, activeFrom: CATALOGUE_FROM });
    }
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    await adminDb.insert(expenses).values({
      organizationId,
      name: "Аренда",
      category: "rent",
      spentOn: "2026-03-01",
      amountMinor: 500_000,
      currency: "MDL",
      isRecurring: false,
    });

    for (const [specialistId, day] of [
      [owner.id, "04"],
      [owner.id, "11"],
      [hired.id, "18"],
    ] as const) {
      await withTenant(organizationId, async (tx) => {
        const result = await recordCompletedVisit(tx, {
          organizationId,
          actor: { userId, role: "owner" },
          serviceId: service.id,
          specialistId,
          clientId: null,
          addOnIds: [],
          completedAt: new Date(`2026-03-${day}T10:00:00.000Z`),
          actualDurationMinutes: 90,
          requestId: "test",
        });
        if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      });
    }

    const report = () =>
      withTenant(organizationId, (tx) => loadPeriodPL(tx, { month: "2026-03", currency: "MDL", organizationId }, "ru"));

    const before = await report();

    await adminDb.execute(sql.raw(backfillStatement()));
    expect((await flags([organizationId]))[organizationId]).toBe(true);
    expect(await report()).toEqual(before);

    await adminDb.update(organizations).set({ detailedAnalytics: false }).where(eq(organizations.id, organizationId));
    expect(await report()).toEqual(before);

    /*
     * Pinned, so that «unchanged» is not two copies of one mistake: three visits
     * at 600 and 40%, two of them the owner's own, and 5 000 of rent.
     */
    const { pl } = before;
    expect(pl.revenueMinor).toBe(180_000);
    expect(pl.labourCostMinor).toBe(72_000);
    expect(pl.principalLabourMinor).toBe(48_000);
    expect(pl.contributionMarginMinor).toBe(108_000);
    expect(pl.operatingProfitMinor).toBe(108_000 + 48_000 - 500_000);

    // And the plain view says the same month in its own three words.
    expect(basicPL(pl)).toEqual({
      paidToMastersMinor: 24_000,
      leftAfterVisitsMinor: 156_000,
      leftForMonthMinor: pl.operatingProfitMinor,
    });
  });
});
