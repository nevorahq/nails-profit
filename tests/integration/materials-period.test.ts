import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { expenses, materialsCostingPeriods, services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { ExpenseCategory } from "@/domain/expense-categories";
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
 * A month counted per service, against real rows.
 *
 * The invariant is the one the mode exists for: every leu of materials is
 * subtracted once. Counted by purchases it is the crate of gel, in the month it
 * was bought; counted per service it is what each visit took off its own
 * margin, and the crate is cash only. And switching from April leaves March —
 * its visits, its purchases, its profit — exactly as it was reported.
 */
describe("materials in the monthly report", () => {
  let userId: string;
  let organizationId: string;
  let specialistId: string;
  let serviceId: string;

  const MATERIALS = 3_500;
  const GEL = 50_000;
  const RENT = 300_000;

  async function closeVisit(at: Date) {
    return withTenant(organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId,
        actor: { userId, role: "owner" },
        serviceId,
        specialistId,
        clientId: null,
        addOnIds: [],
        completedAt: at,
        actualDurationMinutes: 90,
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result;
    });
  }

  async function record(category: ExpenseCategory, amountMinor: number, spentOn: string) {
    await adminDb.insert(expenses).values({
      organizationId,
      name: category,
      category,
      spentOn,
      amountMinor,
      currency: "MDL",
    });
  }

  function report(month: string) {
    return withTenant(organizationId, (tx) => loadPeriodPL(tx, { month, currency: "MDL", organizationId }, "ru"));
  }

  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
    organizationId = (await createOrganization({ ownerId: userId })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: new Date("2025-01-01T00:00:00.000Z"),
    });
    serviceId = (await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 })).id;
    await adminDb.update(services).set({ materialsMinor: MATERIALS }).where(eq(services.id, serviceId));

    for (const month of ["2026-03", "2026-04"]) {
      await record("rent", RENT, `${month}-01`);
      await record("materials", GEL, `${month}-05`);
    }
  });

  it("subtracts the purchases, and nothing per visit, in a month counted by purchases", async () => {
    await closeVisit(new Date("2026-03-15T12:00:00.000Z"));
    const march = await report("2026-03");

    expect(march.materials).toEqual({ mode: "purchases", perServiceMinor: 0, purchasedMinor: GEL });
    expect(march.pl.contributionMarginMinor).toBe(36_000);
    expect(march.pl.overheadMinor).toBe(RENT + GEL);
  });

  it("subtracts what the visits used, and not the purchases, in a month counted per service", async () => {
    await adminDb.insert(materialsCostingPeriods).values({
      organizationId,
      mode: "per_service",
      effectiveFrom: "2026-04-01",
    });
    await closeVisit(new Date("2026-04-15T12:00:00.000Z"));
    await closeVisit(new Date("2026-04-16T12:00:00.000Z"));
    const april = await report("2026-04");

    expect(april.materials).toEqual({ mode: "per_service", perServiceMinor: 2 * MATERIALS, purchasedMinor: GEL });
    // Inside the margin, once per visit…
    expect(april.pl.contributionMarginMinor).toBe(2 * (36_000 - MATERIALS));
    // …and the gel bought is out of the overhead, shown as cash only.
    expect(april.pl.overheadMinor).toBe(RENT);
    expect(april.pl.cashOnlyMinor).toBe(GEL);
    // Money still left the account for it: the cash flow pays the crate.
    expect(april.cashFlow.spentFromLedgerMinor).toBe(RENT + GEL);
  });

  it("leaves the month before the switch exactly as it was reported", async () => {
    await closeVisit(new Date("2026-03-15T12:00:00.000Z"));
    const before = await report("2026-03");

    await adminDb.insert(materialsCostingPeriods).values({
      organizationId,
      mode: "per_service",
      effectiveFrom: "2026-04-01",
    });
    await closeVisit(new Date("2026-04-15T12:00:00.000Z"));

    expect(await report("2026-03")).toEqual(before);
  });
});
