import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { financialSnapshots, paymentMethods, taxRules, visitLines, visits } from "@/db/schema";
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
 * Taxes, acquiring and refunds against real rows.
 *
 * What only a database can check here is that the rates are *snapshotted*: the
 * arithmetic is pinned down by `domain/costing.test.ts`, and what this file
 * asks is whether a visit closed in March goes on costing March's VAT after the
 * rate changes in July.
 */
describe("a visit under costing-v2", () => {
  let userId: string;
  let organizationId: string;
  let specialistId: string;
  let serviceId: string;

  const CATALOGUE_FROM = new Date("2025-01-01T00:00:00.000Z");
  const MARCH = new Date("2026-03-10T10:00:00.000Z");

  async function close(options: { at?: Date; paymentMethodId?: string | null } = {}) {
    return withTenant(organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId,
        actor: { userId, role: "owner" },
        serviceId,
        specialistId,
        clientId: null,
        addOnIds: [],
        completedAt: options.at ?? MARCH,
        actualDurationMinutes: 90,
        ...(options.paymentMethodId !== undefined ? { paymentMethodId: options.paymentMethodId } : {}),
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result;
    });
  }

  async function addMethod(options: {
    name?: string;
    basisPoints?: number;
    fixedFeeMinor?: number;
    isDefault?: boolean;
  }) {
    const [row] = await adminDb
      .insert(paymentMethods)
      .values({
        organizationId,
        name: options.name ?? "Терминал",
        kind: "card",
        commissionBasisPoints: options.basisPoints ?? 220,
        fixedFeeMinor: options.fixedFeeMinor ?? 0,
        isDefault: options.isDefault ?? false,
      })
      .returning();
    return row;
  }

  async function addTax(options: {
    kind?: "vat" | "turnover" | "payroll";
    basisPoints: number;
    remittable?: boolean;
    activeFrom?: Date;
    activeTo?: Date | null;
  }) {
    await adminDb.insert(taxRules).values({
      organizationId,
      kind: options.kind ?? "vat",
      basisPoints: options.basisPoints,
      remittable: options.remittable ?? true,
      activeFrom: options.activeFrom ?? CATALOGUE_FROM,
      activeTo: options.activeTo ?? null,
    });
  }

  /** Re-costs the visit and writes the next snapshot, as an adjustment does. */
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
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: CATALOGUE_FROM,
    });

    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    serviceId = service.id;
  });

  /*
   * The migration's whole promise in one assertion: a studio that has entered
   * neither a payment method nor a tax gets the figures it always had, under a
   * formula version that says v2.
   */
  it("costs exactly as before when nothing has been entered", async () => {
    const { visit, snapshot } = await close();

    expect(snapshot.contributionMarginMinor).toBe(36_000);
    expect(snapshot.netRevenueMinor).toBe(60_000);
    expect(snapshot.vatMinor).toBe(0);
    expect(snapshot.paymentCommissionMinor).toBe(0);
    expect(visit.paymentMethodId).toBeNull();
    expect(visit.taxSnapshot).toBeNull();
  });

  it("takes the studio's default method when the caller says nothing", async () => {
    const method = await addMethod({ isDefault: true, basisPoints: 220, fixedFeeMinor: 100 });

    const { visit, snapshot } = await close();

    expect(visit.paymentMethodId).toBe(method.id);
    expect(visit.paymentCommissionBasisPointsSnapshot).toBe(220);
    expect(snapshot.paymentCommissionMinor).toBe(1_420);
    expect(snapshot.contributionMarginMinor).toBe(36_000 - 1_420);
  });

  it("obeys an explicit cash payment even when a default exists", async () => {
    await addMethod({ isDefault: true });

    const { visit, snapshot } = await close({ paymentMethodId: null });

    // The one client who paid in notes must be recordable without a fee the
    // bank never charged.
    expect(visit.paymentMethodId).toBeNull();
    expect(snapshot.paymentCommissionMinor).toBe(0);
  });

  it("ignores a method that is not this tenant's", async () => {
    const other = await createOrganization({ name: "Соседи" });
    const [theirs] = await adminDb
      .insert(paymentMethods)
      .values({ organizationId: other.id, name: "Их терминал", kind: "card", commissionBasisPoints: 9_000 })
      .returning();

    const { visit, snapshot } = await close({ paymentMethodId: theirs.id });

    // RLS finds nothing, and the visit is costed as cash rather than at a rate
    // nobody here agreed to.
    expect(visit.paymentMethodId).toBeNull();
    expect(snapshot.paymentCommissionMinor).toBe(0);
  });

  it("snapshots the tax rates into the visit", async () => {
    await addTax({ basisPoints: 2_000 });

    const { visit, snapshot } = await close();

    expect(visit.taxSnapshot).toEqual({
      vatBasisPoints: 2_000,
      remittableVat: true,
      turnoverBasisPoints: 0,
      payrollBasisPoints: 0,
    });
    expect(snapshot.vatMinor).toBe(10_000);
    expect(snapshot.netRevenueMinor).toBe(50_000);
    expect(snapshot.contributionMarginMinor).toBe(26_000);
  });

  /*
   * The reason the rates are copied in at all. A rate that changes must leave
   * the months before it reporting what they reported.
   */
  it("goes on costing March's VAT after the rate changes in July", async () => {
    await addTax({ basisPoints: 2_000, activeTo: new Date("2026-07-01T00:00:00.000Z") });
    const { visit, snapshot } = await close();

    await addTax({ basisPoints: 800, activeFrom: new Date("2026-07-01T00:00:00.000Z") });
    const reCosted = await reCost(visit.id);

    expect(snapshot.vatMinor).toBe(10_000);
    expect(reCosted.vatMinor).toBe(10_000);
    expect(reCosted.contributionMarginMinor).toBe(snapshot.contributionMarginMinor);
  });

  it("keeps the acquiring rate a visit closed at when the contract changes", async () => {
    const method = await addMethod({ isDefault: true, basisPoints: 220 });
    const { visit, snapshot } = await close();

    await adminDb
      .update(paymentMethods)
      .set({ commissionBasisPoints: 900 })
      .where(eq(paymentMethods.id, method.id));
    const reCosted = await reCost(visit.id);

    expect(reCosted.paymentCommissionMinor).toBe(snapshot.paymentCommissionMinor);
  });

  it("records a rate that is not remitted without taking it out", async () => {
    await addTax({ basisPoints: 2_000, remittable: false });

    const { visit, snapshot } = await close();

    // Nothing would be subtracted, so the visit carries no snapshot at all:
    // «налогов не было» and «никто не спрашивал» stay distinguishable.
    expect(visit.taxSnapshot).toBeNull();
    expect(snapshot.contributionMarginMinor).toBe(36_000);
  });

  describe("refunds", () => {
    it("takes a refund out of revenue and out of the commission", async () => {
      const { visit } = await close();

      await adminDb
        .update(visitLines)
        .set({ refundMinor: 10_000 })
        .where(eq(visitLines.visitId, visit.id));
      const snapshot = await reCost(visit.id);

      expect(snapshot.revenueMinor).toBe(50_000);
      // 40% of what the client actually kept paying for, not of the original.
      expect(snapshot.commissionMinor).toBe(20_000);
      expect(snapshot.contributionMarginMinor).toBe(50_000 - 20_000);
    });

    it("leaves the acquirer's fee on the sum that was processed", async () => {
      await addMethod({ isDefault: true, basisPoints: 220 });
      const { visit } = await close();

      await adminDb
        .update(visitLines)
        .set({ refundMinor: 20_000 })
        .where(eq(visitLines.visitId, visit.id));
      const snapshot = await reCost(visit.id);

      // 2.2% of the 600 the terminal processed, not of the 400 kept.
      expect(snapshot.paymentCommissionMinor).toBe(1_320);
    });

    it("refuses to give back more than the line took", async () => {
      const { visit } = await close();

      // Without the constraint a typo turns the visit's revenue negative, and
      // every total above it with it.
      await expectDatabaseError(
        adminDb.update(visitLines).set({ refundMinor: 70_000 }).where(eq(visitLines.visitId, visit.id)),
        { code: PG_ERROR.check, constraint: "visit_line_refund_within_charged" },
      );
    });

    it("writes the correction as a new version and leaves the first alone", async () => {
      const { visit, snapshot } = await close();

      await adminDb
        .update(visitLines)
        .set({ refundMinor: 10_000 })
        .where(eq(visitLines.visitId, visit.id));
      await reCost(visit.id);

      const versions = await adminDb
        .select({ version: financialSnapshots.snapshotVersion, revenue: financialSnapshots.revenueMinor })
        .from(financialSnapshots)
        .where(eq(financialSnapshots.visitId, visit.id));

      expect(versions).toHaveLength(2);
      expect(versions.find((row) => row.version === 1)!.revenue).toBe(snapshot.revenueMinor);
      expect(versions.find((row) => row.version === 2)!.revenue).toBe(50_000);
    });
  });

  it("does not read another tenant's tax rules", async () => {
    const other = await createOrganization({ name: "Соседи" });
    await adminDb
      .insert(taxRules)
      .values({ organizationId: other.id, kind: "vat", basisPoints: 2_000, activeFrom: CATALOGUE_FROM });

    const { visit, snapshot } = await close();

    expect(visit.taxSnapshot).toBeNull();
    expect(snapshot.contributionMarginMinor).toBe(36_000);
  });

  it("keeps the visit costed when its payment method is later retired", async () => {
    const method = await addMethod({ isDefault: true, basisPoints: 220 });
    const { visit, snapshot } = await close();

    // Archiving is what the API does; the snapshot on the visit is what the
    // costing reads, so the fee survives either way.
    await adminDb
      .update(paymentMethods)
      .set({ archivedAt: new Date(), isDefault: false })
      .where(eq(paymentMethods.id, method.id));
    const reCosted = await reCost(visit.id);

    expect(reCosted.paymentCommissionMinor).toBe(snapshot.paymentCommissionMinor);

    const [stored] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(stored.paymentCommissionBasisPointsSnapshot).toBe(220);
  });
});
