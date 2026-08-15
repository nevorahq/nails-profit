import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { clients, consumptions, financialSnapshots, visitLines, visits } from "@/db/schema";
import { calculateVisitProfit } from "@/domain/visit-profit";
import { PG_ERROR } from "@/lib/db-errors";
import { toMilliUnits } from "@/domain/units";
import { adminDb, resetDatabase } from "../helpers/database";
import { expectDatabaseError } from "../helpers/expect-database-error";
import {
  addMaterialPrice,
  createClient,
  createMaterial,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
  createVisit,
} from "../helpers/factories";

/**
 * The promise phase 3 rests on: a closed visit keeps the numbers it was closed
 * with. Raising a supplier price or editing a recipe afterwards must leave it
 * untouched, and the financial result must be impossible to overwrite in place.
 */
describe("visit snapshots", () => {
  let organizationId: string;
  let userId: string;
  let specialistId: string;

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    userId = user.id;
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
  });

  it("keeps a client's contacts unique within the organization but optional", async () => {
    await createClient(organizationId, { normalizedPhone: "+37360123456" });

    await expectDatabaseError(
      createClient(organizationId, { name: "Дубль", normalizedPhone: "+37360123456" }),
      { code: PG_ERROR.unique, constraint: "client_org_phone_idx" },
    );

    // Any number of clients may have no phone at all.
    await createClient(organizationId, { name: "Без телефона" });
    await createClient(organizationId, { name: "Тоже без" });

    const rows = await adminDb.select().from(clients).where(eq(clients.organizationId, organizationId));
    expect(rows).toHaveLength(3);
  });

  it("matches a client's email case-insensitively", async () => {
    await createClient(organizationId, { email: "Client@Example.com" });

    await expectDatabaseError(createClient(organizationId, { email: "client@example.com" }), {
      code: PG_ERROR.unique,
      constraint: "client_org_email_idx",
    });
  });

  it("lets the same phone belong to a client in another organization", async () => {
    const other = await createOrganization({ name: "Other" });
    await createClient(organizationId, { normalizedPhone: "+37360123456" });

    const elsewhere = await createClient(other.id, { normalizedPhone: "+37360123456" });
    expect(elsewhere.organizationId).toBe(other.id);
  });

  it("refuses a visit with no duration and a discount larger than the price", async () => {
    await expectDatabaseError(
      createVisit(organizationId, { specialistId, plannedDurationMinutes: 0 }),
      { code: PG_ERROR.check, constraint: "visit_planned_duration_positive" },
    );

    const visit = await createVisit(organizationId, { specialistId });
    await expectDatabaseError(
      adminDb.insert(visitLines).values({
        organizationId,
        visitId: visit.id,
        kind: "service",
        nameSnapshot: { ru: "Услуга" },
        priceMinor: 10_000,
        discountMinor: 20_000,
      }),
      { code: PG_ERROR.check, constraint: "visit_line_discount_within_price" },
    );
  });

  it("refuses the same material twice on one visit", async () => {
    const material = await createMaterial(organizationId);
    const visit = await createVisit(organizationId, { specialistId });
    const row = {
      organizationId,
      visitId: visit.id,
      materialId: material.id,
      materialNameSnapshot: "Гель",
      baseUnitSnapshot: "ml" as const,
      normativeQuantityMilliUnits: 2_000,
    };

    await adminDb.insert(consumptions).values(row);
    await expectDatabaseError(adminDb.insert(consumptions).values(row), {
      code: PG_ERROR.unique,
      constraint: "consumption_visit_material_idx",
    });
  });

  it("refuses to update or delete a financial snapshot", async () => {
    // Append-only is enforced by a trigger, not by convention: an UPDATE here
    // would silently rewrite a past month's profit.
    const visit = await createVisit(organizationId, { specialistId });
    const [snapshot] = await adminDb
      .insert(financialSnapshots)
      .values({
        organizationId,
        visitId: visit.id,
        snapshotVersion: 1,
        currency: "MDL",
        formulaVersion: "costing-v1",
        revenueMinor: 60_000,
        contributionMarginMinor: 34_000,
      })
      .returning();

    await expectDatabaseError(
      adminDb
        .update(financialSnapshots)
        .set({ contributionMarginMinor: 999_999 })
        .where(eq(financialSnapshots.id, snapshot.id)),
      { code: "23001" },
    );

    await expectDatabaseError(
      adminDb.delete(financialSnapshots).where(eq(financialSnapshots.id, snapshot.id)),
      { code: "23001" },
    );

    const [after] = await adminDb
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.id, snapshot.id));
    expect(after.contributionMarginMinor).toBe(34_000);
  });

  it("allows a correction to be added as a new version", async () => {
    // Section 8.8.1: an adjustment writes a new snapshot rather than editing one.
    const visit = await createVisit(organizationId, { specialistId });
    const base = {
      organizationId,
      visitId: visit.id,
      formulaVersion: "costing-v1",
      currency: "MDL" as const,
      revenueMinor: 60_000,
    };

    await adminDb.insert(financialSnapshots).values({ ...base, snapshotVersion: 1 });
    await adminDb.insert(financialSnapshots).values({ ...base, snapshotVersion: 2, revenueMinor: 50_000 });

    await expectDatabaseError(
      adminDb.insert(financialSnapshots).values({ ...base, snapshotVersion: 2 }),
      { code: PG_ERROR.unique, constraint: "financial_snapshot_visit_version_idx" },
    );

    const versions = await adminDb
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, visit.id));
    expect(versions).toHaveLength(2);
  });

  it("does not re-price a closed visit when the material price later changes", async () => {
    // The reason snapshots exist at all.
    const material = await createMaterial(organizationId, {
      packagePriceMinor: 10_000,
      packageSize: 10,
      createdBy: userId,
    });
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    const client = await createClient(organizationId);
    const visit = await createVisit(organizationId, {
      specialistId,
      clientId: client.id,
      serviceId: service.id,
      actualDurationMinutes: 90,
    });

    await adminDb.insert(visitLines).values({
      organizationId,
      visitId: visit.id,
      kind: "service",
      serviceId: service.id,
      nameSnapshot: service.name,
      priceMinor: 60_000,
      durationMinutes: 90,
    });
    await adminDb.insert(consumptions).values({
      organizationId,
      visitId: visit.id,
      materialId: material.id,
      materialNameSnapshot: material.name,
      baseUnitSnapshot: "ml",
      normativeQuantityMilliUnits: toMilliUnits(2),
      actualQuantityMilliUnits: toMilliUnits(2),
      packagePriceMinorSnapshot: 10_000,
      packageSizeMilliUnitsSnapshot: toMilliUnits(10),
    });

    // The supplier doubles the price and the catalogue is updated.
    await addMaterialPrice(organizationId, material.id, {
      packagePriceMinor: 20_000,
      packageSize: 10,
      createdBy: userId,
    });

    const stored = await adminDb
      .select()
      .from(consumptions)
      .where(eq(consumptions.visitId, visit.id));

    const profit = calculateVisitProfit({
      currency: "MDL",
      lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0 }],
      consumptions: stored.map((row) => ({
        materialId: row.materialId,
        normativeQuantityMilliUnits: row.normativeQuantityMilliUnits,
        actualQuantityMilliUnits: row.actualQuantityMilliUnits,
        packagePriceMinor: row.packagePriceMinorSnapshot,
        packageSizeMilliUnits: row.packageSizeMilliUnitsSnapshot,
      })),
      commission: { type: "percentage", basisPoints: 4_000 },
      plannedDurationMinutes: 90,
      actualDurationMinutes: 90,
    });

    expect(profit.status).toBe("complete");
    if (profit.status !== "complete") throw new Error("expected complete");
    // Still 20 MDL of gel, the price on the day, not 40.
    expect(profit.costing.materialCostMinor).toBe(2_000);
    expect(profit.costing.contributionMarginMinor).toBe(34_000);
  });

  it("keeps a visit readable after its service is archived", async () => {
    // SRV-004: the name is copied, so history does not go blank when the
    // catalogue moves on.
    const service = await createService(organizationId, { name: "Старая услуга" });
    const visit = await createVisit(organizationId, { specialistId, serviceId: service.id });
    await adminDb.insert(visitLines).values({
      organizationId,
      visitId: visit.id,
      kind: "service",
      serviceId: service.id,
      nameSnapshot: { ru: "Старая услуга" },
      priceMinor: 60_000,
    });

    const { services } = await import("@/db/schema");
    await adminDb.update(services).set({ archivedAt: new Date() }).where(eq(services.id, service.id));

    const [line] = await adminDb.select().from(visitLines).where(eq(visitLines.visitId, visit.id));
    expect(line.nameSnapshot).toEqual({ ru: "Старая услуга" });
  });

  it("refuses to delete a material a visit consumed", async () => {
    const material = await createMaterial(organizationId);
    const visit = await createVisit(organizationId, { specialistId });
    await adminDb.insert(consumptions).values({
      organizationId,
      visitId: visit.id,
      materialId: material.id,
      materialNameSnapshot: "Гель",
      baseUnitSnapshot: "ml",
      normativeQuantityMilliUnits: 2_000,
    });

    const { materials } = await import("@/db/schema");
    await expectDatabaseError(
      adminDb.delete(materials).where(eq(materials.id, material.id)),
      { code: PG_ERROR.foreignKey },
    );
  });

  it("keeps visits out of another tenant's reach", async () => {
    const other = await createOrganization({ name: "Other" });
    const otherSpecialist = await createSpecialist(other.id);
    await createVisit(other.id, { specialistId: otherSpecialist.id });
    await createVisit(organizationId, { specialistId });

    const { withTenant } = await import("@/db/tenant");
    const seen = await withTenant(organizationId, (tx) => tx.select().from(visits));
    expect(seen).toHaveLength(1);
    expect(seen[0].organizationId).toBe(organizationId);
  });

  it("anonymizes a client without losing the visit that points at them", async () => {
    // Section 15.3: erasure anonymizes PII and keeps the financial record.
    const client = await createClient(organizationId, {
      name: "Мария Попеску",
      normalizedPhone: "+37360123456",
      email: "maria@example.com",
    });
    const visit = await createVisit(organizationId, { specialistId, clientId: client.id });

    await adminDb
      .update(clients)
      .set({
        name: sql`'Удалённый клиент'`,
        normalizedPhone: null,
        email: null,
        anonymizedAt: new Date(),
      })
      .where(eq(clients.id, client.id));

    const [after] = await adminDb.select().from(clients).where(eq(clients.id, client.id));
    expect(after.normalizedPhone).toBeNull();
    expect(after.email).toBeNull();
    expect(after.anonymizedAt).not.toBeNull();

    const [stillThere] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(stillThere.clientId).toBe(client.id);
  });
});

/**
 * The service layer that closes and re-costs a visit. These exercise the same
 * functions the API route calls, so a regression in snapshotting shows up here
 * rather than in production.
 */
describe("closing and adjusting a visit", () => {
  let organizationId: string;
  let userId: string;
  let specialistId: string;
  let serviceId: string;
  let materialId: string;

  async function close(actualQuantity: number | null) {
    const { withTenant } = await import("@/db/tenant");
    const { buildVisitDraft, recalculateVisitProfit, writeFinancialSnapshot } = await import(
      "@/lib/visit-service"
    );

    return withTenant(organizationId, async (tx) => {
      const at = new Date();
      const draft = (await buildVisitDraft(tx, {
        serviceId,
        addOnIds: [],
        specialistId,
        at,
      }))!;

      const [visit] = await tx
        .insert(visits)
        .values({
          organizationId,
          specialistId,
          serviceId,
          completedAt: at,
          plannedDurationMinutes: draft.plannedDurationMinutes,
          actualDurationMinutes: draft.plannedDurationMinutes,
          commissionType: draft.commission!.type,
          commissionBasisPoints: draft.commission!.basisPoints,
          commissionFixedAmountMinor: draft.commission!.fixedAmountMinor,
        })
        .returning();

      await tx.insert(visitLines).values(
        draft.lines.map((line) => ({
          organizationId,
          visitId: visit.id,
          kind: line.kind,
          serviceId: line.serviceId,
          addOnId: line.addOnId,
          nameSnapshot: line.nameSnapshot,
          priceMinor: line.priceMinor,
          discountMinor: line.discountMinor,
          durationMinutes: line.durationMinutes,
        })),
      );

      await tx.insert(consumptions).values(
        draft.consumptions.map((line) => ({
          organizationId,
          visitId: visit.id,
          materialId: line.materialId,
          materialNameSnapshot: line.materialNameSnapshot,
          baseUnitSnapshot: line.baseUnitSnapshot,
          normativeQuantityMilliUnits: line.normativeQuantityMilliUnits,
          actualQuantityMilliUnits: actualQuantity === null ? null : toMilliUnits(actualQuantity),
          packagePriceMinorSnapshot: line.packagePriceMinorSnapshot,
          packageSizeMilliUnitsSnapshot: line.packageSizeMilliUnitsSnapshot,
        })),
      );

      const profit = (await recalculateVisitProfit(tx, visit.id))!.profit;
      const snapshot = await writeFinancialSnapshot(tx, {
        organizationId,
        visitId: visit.id,
        profit,
        actorUserId: userId,
      });
      return { visitId: visit.id, snapshot };
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    userId = user.id;
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;

    const { createCommissionRule, createRecipe } = await import("../helpers/factories");
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });

    // 100 MDL for 10 ml, so 10 MDL per ml.
    const material = await createMaterial(organizationId, {
      packagePriceMinor: 10_000,
      packageSize: 10,
      createdBy: userId,
    });
    materialId = material.id;
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    serviceId = service.id;
    await createRecipe(organizationId, service.id, [{ materialId: material.id, quantity: 2 }]);
  });

  it("snapshots the catalogue when the visit is closed", async () => {
    const { snapshot } = await close(2);

    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.revenueMinor).toBe(60_000);
    expect(snapshot.materialCostMinor).toBe(2_000);
    expect(snapshot.contributionMarginMinor).toBe(34_000);
    expect(snapshot.incompleteReasons).toEqual([]);
  });

  it("uses the snapshotted standard quantity when actual usage is absent", async () => {
    const { snapshot } = await close(null);

    expect(snapshot.revenueMinor).toBe(60_000);
    expect(snapshot.contributionMarginMinor).toBe(34_000);
    expect(snapshot.materialCostMinor).toBe(2_000);
    expect(snapshot.materialUsageSource).toBe("standard");
    expect(snapshot.incompleteReasons).toEqual([]);
    expect(snapshot.normativeMaterialCostMinor).toBe(2_000);
  });

  it("leaves a closed visit alone when the material price later changes", async () => {
    const { visitId } = await close(2);

    await addMaterialPrice(organizationId, materialId, {
      packagePriceMinor: 20_000,
      packageSize: 10,
      createdBy: userId,
    });

    const { withTenant } = await import("@/db/tenant");
    const { recalculateVisitProfit } = await import("@/lib/visit-service");
    const again = await withTenant(organizationId, (tx) => recalculateVisitProfit(tx, visitId));

    expect(again!.profit.status).toBe("complete");
    if (again!.profit.status !== "complete") throw new Error("expected complete");
    expect(again!.profit.costing.materialCostMinor).toBe(2_000);
  });

  it("prices a new visit with the new price while the old one keeps the old", async () => {
    const first = await close(2);

    await addMaterialPrice(organizationId, materialId, {
      packagePriceMinor: 20_000,
      packageSize: 10,
      createdBy: userId,
    });
    const second = await close(2);

    expect(first.snapshot.contributionMarginMinor).toBe(34_000);
    expect(second.snapshot.contributionMarginMinor).toBe(32_000);
  });

  it("adds a correction as a new version and keeps the first", async () => {
    const { visitId } = await close(2);

    const { withTenant } = await import("@/db/tenant");
    const { recalculateVisitProfit, writeFinancialSnapshot } = await import("@/lib/visit-service");

    const corrected = await withTenant(organizationId, async (tx) => {
      await tx
        .update(consumptions)
        .set({ actualQuantityMilliUnits: toMilliUnits(5) })
        .where(eq(consumptions.visitId, visitId));
      const profit = (await recalculateVisitProfit(tx, visitId))!.profit;
      return writeFinancialSnapshot(tx, {
        organizationId,
        visitId,
        profit,
        actorUserId: userId,
      });
    });

    expect(corrected.snapshotVersion).toBe(2);
    expect(corrected.contributionMarginMinor).toBe(31_000);

    const history = await adminDb
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, visitId));
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.snapshotVersion === 1)!.contributionMarginMinor).toBe(34_000);
  });

  it("records the deviation between the recipe and what was used", async () => {
    const { visitId } = await close(5);

    const { withTenant } = await import("@/db/tenant");
    const { recalculateVisitProfit } = await import("@/lib/visit-service");
    const result = await withTenant(organizationId, (tx) => recalculateVisitProfit(tx, visitId));

    // Normative 2 ml at 10 MDL, actually 5 ml: 30 MDL over, 150 percent.
    expect(result!.profit.deviation).toMatchObject({
      normativeCostMinor: 2_000,
      actualCostMinor: 5_000,
      deviationMinor: 3_000,
      deviationBasisPoints: 15_000,
    });
  });
});
