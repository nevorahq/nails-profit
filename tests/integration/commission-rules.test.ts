import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { commissionRules, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { PG_ERROR } from "@/lib/db-errors";
import { recalculateVisitProfit, recordCompletedVisit, writeFinancialSnapshot } from "@/lib/visit-service";
import { adminDb, resetDatabase } from "../helpers/database";
import { expectDatabaseError } from "../helpers/expect-database-error";
import {
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * Payroll v2 against real rows.
 *
 * The arithmetic is settled in `domain/costing.test.ts` and
 * `domain/visit-profit.test.ts`. What only a database can answer is whether the
 * arrangement is *snapshotted*: a rule edited in July must leave a visit closed
 * in March paying what March agreed to.
 */
describe("commission rules v2", () => {
  let userId: string;
  let organizationId: string;
  let specialistId: string;
  let serviceId: string;

  const CATALOGUE_FROM = new Date("2025-01-01T00:00:00.000Z");
  const MARCH = new Date("2026-03-10T10:00:00.000Z");

  async function close(options: { addOnIds?: string[] } = {}) {
    return withTenant(organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId,
        actor: { userId, role: "owner" },
        serviceId,
        specialistId,
        clientId: null,
        addOnIds: options.addOnIds ?? [],
        completedAt: MARCH,
        actualDurationMinutes: 90,
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result;
    });
  }

  async function reCost(visitId: string) {
    return withTenant(organizationId, async (tx) => {
      const after = await recalculateVisitProfit(tx, visitId);
      return writeFinancialSnapshot(tx, {
        organizationId,
        visitId,
        profit: after!.profit,
        actorUserId: userId,
      });
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
    organizationId = (await createOrganization({ ownerId: userId })).id;
    specialistId = (await createSpecialist(organizationId)).id;

    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    serviceId = service.id;
  });

  it("costs a plain percentage rule exactly as it always did", async () => {
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: CATALOGUE_FROM,
    });

    const { visit, snapshot } = await close();

    expect(snapshot.commissionMinor).toBe(24_000);
    expect(snapshot.contributionMarginMinor).toBe(36_000);
    // The default base is stored rather than left null, so the visit says what
    // it was costed on instead of relying on a reader knowing the default.
    expect(visit.commissionBase).toBe("after_discount");
  });

  it("pays a hybrid its guarantee and its share", async () => {
    await createCommissionRule(organizationId, specialistId, {
      type: "hybrid",
      basisPoints: 2_000,
      fixedAmountMinor: 5_000,
      activeFrom: CATALOGUE_FROM,
    });

    const { snapshot } = await close();

    expect(snapshot.commissionMinor).toBe(5_000 + 12_000);
  });

  it("marks every line commissionable when the rule names no services", async () => {
    await createCommissionRule(organizationId, specialistId, { activeFrom: CATALOGUE_FROM });

    const { visit } = await close();
    const lines = await adminDb
      .select({ commissionable: visitLines.commissionable })
      .from(visitLines)
      .where(eq(visitLines.visitId, visit.id));

    expect(lines.every((line) => line.commissionable)).toBe(true);
  });

  it("leaves a line out when the rule does not cover its service", async () => {
    const other = await createService(organizationId, { priceMinor: 20_000, durationMinutes: 30 });
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      coveredServiceIds: [other.id],
      activeFrom: CATALOGUE_FROM,
    });

    const { snapshot } = await close();

    // The visit sold a service the rule does not cover, so the percentage has
    // nothing to apply to — and the revenue is untouched.
    expect(snapshot.revenueMinor).toBe(60_000);
    expect(snapshot.commissionMinor).toBe(0);
  });

  it("pays on the full price when the rule says so", async () => {
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      base: "full_price",
      activeFrom: CATALOGUE_FROM,
    });

    const { visit } = await close();
    await adminDb
      .update(visitLines)
      .set({ discountMinor: 10_000 })
      .where(eq(visitLines.visitId, visit.id));
    const snapshot = await reCost(visit.id);

    // 40% of 600 even though the client paid 500.
    expect(snapshot.revenueMinor).toBe(50_000);
    expect(snapshot.commissionMinor).toBe(24_000);
  });

  /*
   * The reason any of this is snapshotted. A studio that renegotiates in July
   * must not find that March re-costs itself at July's terms the next time a
   * visit is corrected.
   */
  it("goes on paying March's arrangement after the rule changes", async () => {
    const rule = await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      base: "full_price",
      activeFrom: CATALOGUE_FROM,
    });
    const { visit, snapshot } = await close();

    await adminDb
      .update(commissionRules)
      .set({ basisPoints: 1_000, base: "after_discount" })
      .where(eq(commissionRules.id, rule.id));
    const reCosted = await reCost(visit.id);

    expect(reCosted.commissionMinor).toBe(snapshot.commissionMinor);
  });

  it("keeps which lines were covered even after the rule's list changes", async () => {
    const other = await createService(organizationId, { priceMinor: 20_000, durationMinutes: 30 });
    const rule = await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      coveredServiceIds: [other.id],
      activeFrom: CATALOGUE_FROM,
    });
    const { visit } = await close();

    const { commissionRuleServices } = await import("@/db/schema");
    await adminDb
      .delete(commissionRuleServices)
      .where(eq(commissionRuleServices.commissionRuleId, rule.id));
    const reCosted = await reCost(visit.id);

    // Widening the rule today does not retroactively pay for March.
    expect(reCosted.commissionMinor).toBe(0);
  });

  describe("the rewritten integrity rules", () => {
    it("refuses a hybrid rule missing its guarantee", async () => {
      await expectDatabaseError(
        adminDb.insert(commissionRules).values({
          organizationId,
          specialistId,
          type: "hybrid",
          basisPoints: 2_000,
          fixedAmountMinor: null,
        }),
        { code: PG_ERROR.check, constraint: "commission_rule_shape" },
      );
    });

    it("refuses a percentage rule that also carries an amount", async () => {
      // The old constraint said this too; the rewrite must not have loosened it.
      await expectDatabaseError(
        adminDb.insert(commissionRules).values({
          organizationId,
          specialistId,
          type: "percentage",
          basisPoints: 2_000,
          fixedAmountMinor: 5_000,
        }),
        { code: PG_ERROR.check, constraint: "commission_rule_shape" },
      );
    });

    it("refuses a fixed rule that also carries a rate", async () => {
      await expectDatabaseError(
        adminDb.insert(commissionRules).values({
          organizationId,
          specialistId,
          type: "fixed",
          basisPoints: 2_000,
          fixedAmountMinor: 5_000,
        }),
        { code: PG_ERROR.check, constraint: "commission_rule_shape" },
      );
    });

    it("holds the same three shapes on the visit", async () => {
      await createCommissionRule(organizationId, specialistId, { activeFrom: CATALOGUE_FROM });
      const { visit } = await close();

      await expectDatabaseError(
        adminDb
          .update(visits)
          .set({ commissionType: "hybrid", commissionFixedAmountMinor: null })
          .where(eq(visits.id, visit.id)),
        { code: PG_ERROR.check, constraint: "visit_commission_shape" },
      );
    });

    it("accepts each well-formed shape", async () => {
      for (const values of [
        { type: "percentage" as const, basisPoints: 4_000, fixedAmountMinor: null },
        { type: "fixed" as const, basisPoints: null, fixedAmountMinor: 12_000 },
        { type: "hybrid" as const, basisPoints: 1_500, fixedAmountMinor: 8_000 },
      ]) {
        const [row] = await adminDb
          .insert(commissionRules)
          .values({ organizationId, specialistId, ...values })
          .returning({ id: commissionRules.id });
        expect(row.id).toBeTruthy();
      }
    });
  });

  it("does not read another tenant's coverage list", async () => {
    const other = await createOrganization({ name: "Соседи" });
    const theirSpecialist = await createSpecialist(other.id);
    const theirService = await createService(other.id, { priceMinor: 10_000, durationMinutes: 30 });
    await createCommissionRule(other.id, theirSpecialist.id, {
      coveredServiceIds: [theirService.id],
    });

    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: CATALOGUE_FROM,
    });
    const { snapshot } = await close();

    // Our rule covers everything, and a neighbour's list must not narrow it.
    expect(snapshot.commissionMinor).toBe(24_000);
  });
});
