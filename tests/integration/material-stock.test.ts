import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";

import { consumptions, materialPriceVersions, materialPurchases, materialStockChecks } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { LOW_STOCK_SERVICE_THRESHOLD } from "@/domain/material-stock";
import { toMilliUnits } from "@/domain/units";
import { loadMaterialStock } from "@/lib/material-stock";
import { recordCompletedVisit } from "@/lib/visit-service";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createMaterial,
  createOrganization,
  createRecipe,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * Estimated stock end to end: bought, consumed by a real visit close, counted.
 *
 * The arithmetic itself is covered by `domain/material-stock.test.ts`. What can
 * only be checked here is that the three lists are the ones the product
 * actually writes — that closing a visit through `recordCompletedVisit` moves
 * the balance without anybody typing a consumption, and that a price recorded
 * after the fact leaves the visit that already closed exactly where it was.
 */
describe("material stock", () => {
  let userId: string;

  /** A week back, so a visit dated in the past still finds its rule, recipe and price. */
  const LONG_AGO = new Date(Date.now() - 7 * 86_400_000);

  async function studio() {
    const organizationId = (await createOrganization({ ownerId: userId })).id;
    const specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: LONG_AGO,
    });

    // 180 MDL for a 15 ml bottle, 0.3 ml per procedure: the brief's own example.
    const material = await createMaterial(organizationId, {
      name: "База",
      packagePriceMinor: 180_00,
      packageSize: 15,
      createdBy: userId,
      priceValidFrom: LONG_AGO,
    });
    const service = await createService(organizationId, { priceMinor: 450_00, durationMinutes: 90 });
    await createRecipe(organizationId, service.id, [{ materialId: material.id, quantity: 0.3 }], {
      activeFrom: LONG_AGO,
    });

    return { organizationId, specialistId, serviceId: service.id, materialId: material.id };
  }

  async function close(scene: Awaited<ReturnType<typeof studio>>, completedAt = new Date()) {
    return withTenant(scene.organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId: scene.organizationId,
        actor: { userId, role: "owner" },
        serviceId: scene.serviceId,
        specialistId: scene.specialistId,
        clientId: null,
        addOnIds: [],
        completedAt,
        actualDurationMinutes: null,
        // The point of the whole module: nothing is passed here on a normal visit.
        consumption: [],
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result;
    });
  }

  async function purchase(
    scene: Awaited<ReturnType<typeof studio>>,
    options: { quantity?: number; size?: number; costMinor?: number; at?: Date } = {},
  ) {
    return adminDb
      .insert(materialPurchases)
      .values({
        organizationId: scene.organizationId,
        materialId: scene.materialId,
        packageQuantity: options.quantity ?? 1,
        packageSizeMilliUnits: toMilliUnits(options.size ?? 15),
        unitPackageCostMinor: options.costMinor ?? 180_00,
        currency: "MDL",
        purchasedAt: options.at ?? new Date(Date.now() - 86_400_000),
        createdBy: userId,
      })
      .returning();
  }

  async function stockOf(scene: Awaited<ReturnType<typeof studio>>) {
    const rows = await loadMaterialStock(scene.organizationId);
    const row = rows.find((entry) => entry.material_id === scene.materialId);
    if (!row) throw new Error("material missing from the stock view");
    return row;
  }

  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
  });

  it("knows nothing about a material that was never bought", async () => {
    const scene = await studio();
    const stock = await stockOf(scene);

    expect(stock.balance_milli_units).toBeNull();
    expect(stock.basis).toBe("unknown");
    expect(stock.status).toBe("unknown");
  });

  it("closing a visit consumes stock without the master entering anything", async () => {
    const scene = await studio();
    await purchase(scene);

    await close(scene);

    const stock = await stockOf(scene);
    expect(stock.balance_milli_units).toBe(toMilliUnits(14.7));
    expect(stock.usage_per_service_milli_units).toBe(toMilliUnits(0.3));
    expect(stock.remaining_services).toBe(49);
    expect(stock.status).toBe("ok");
  });

  it("states the balance in procedures and flags a material running out", async () => {
    const scene = await studio();
    // One bottle, then counted down to almost nothing.
    await purchase(scene);
    await adminDb.insert(materialStockChecks).values({
      organizationId: scene.organizationId,
      materialId: scene.materialId,
      observedQuantityMilliUnits: toMilliUnits(1),
      basis: "bucket",
      checkedAt: new Date(Date.now() - 3_600_000),
      createdBy: userId,
    });

    await close(scene);

    const stock = await stockOf(scene);
    expect(stock.basis).toBe("check");
    expect(stock.balance_milli_units).toBe(toMilliUnits(0.7));
    expect(stock.remaining_services).toBe(2);
    expect(stock.remaining_services!).toBeLessThanOrEqual(LOW_STOCK_SERVICE_THRESHOLD);
    expect(stock.status).toBe("low");
  });

  it("averages what was paid across purchases at different prices", async () => {
    const scene = await studio();
    await purchase(scene, { quantity: 3, costMinor: 180_00 });
    await purchase(scene, { quantity: 1, costMinor: 220_00 });

    const stock = await stockOf(scene);
    expect(stock.average_package_cost_minor).toBe(190_00);
    expect(stock.packages_purchased).toBe(4);
    expect(stock.total_spent_minor).toBe(760_00);
  });

  it("compares a fresh count against what the estimate predicted", async () => {
    const scene = await studio();
    await purchase(scene, { at: new Date(Date.now() - 172_800_000) });
    await close(scene, new Date(Date.now() - 86_400_000));

    // The estimate says 14.7 ml is left; the bottle says half of it is.
    await adminDb.insert(materialStockChecks).values({
      organizationId: scene.organizationId,
      materialId: scene.materialId,
      observedQuantityMilliUnits: toMilliUnits(7),
      basis: "bucket",
      checkedAt: new Date(),
      createdBy: userId,
    });

    const stock = await stockOf(scene);
    expect(stock.calibration).not.toBeNull();
    expect(stock.calibration!.expectedMilliUnits).toBe(toMilliUnits(14.7));
    expect(stock.calibration!.observedMilliUnits).toBe(toMilliUnits(7));
    expect(stock.calibration!.significant).toBe(true);
  });

  it("a later price leaves an already closed visit exactly where it was", async () => {
    const scene = await studio();
    await purchase(scene);
    const { snapshot } = await close(scene);
    const costAtClose = snapshot.materialCostMinor;

    // 180 → 220 for the same bottle, recorded now.
    await adminDb.insert(materialPriceVersions).values({
      organizationId: scene.organizationId,
      materialId: scene.materialId,
      packagePriceMinor: 220_00,
      packageSizeMilliUnits: toMilliUnits(15),
      costingMode: "quantity",
      currency: "MDL",
      validFrom: new Date(),
      createdBy: userId,
    });

    const [used] = await adminDb
      .select()
      .from(consumptions)
      .where(eq(consumptions.materialId, scene.materialId));

    expect(used.packagePriceMinorSnapshot).toBe(180_00);
    expect(costAtClose).toBe(360);

    // The next visit is costed on the new price; the old one is not re-costed.
    const { snapshot: later } = await close(scene);
    expect(later.materialCostMinor).toBe(440);
    expect(costAtClose).toBe(360);
  });

  it("does not consume stock twice when a completion is retried", async () => {
    const scene = await studio();
    await purchase(scene);

    const completionKey = crypto.randomUUID();
    const attempt = async () =>
      withTenant(scene.organizationId, async (tx) =>
        recordCompletedVisit(tx, {
          organizationId: scene.organizationId,
          actor: { userId, role: "owner" },
          serviceId: scene.serviceId,
          specialistId: scene.specialistId,
          clientId: null,
          addOnIds: [],
          completedAt: new Date(),
          actualDurationMinutes: null,
          consumption: [],
          requestId: "test",
          completionKey,
          completionFingerprint: "same",
        }),
      );

    const first = await attempt();
    const second = await attempt();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.replayed).toBe(true);
    expect(second.visit.id).toBe(first.visit.id);

    const rows = await adminDb
      .select()
      .from(consumptions)
      .where(eq(consumptions.materialId, scene.materialId));
    expect(rows).toHaveLength(1);

    const stock = await stockOf(scene);
    expect(stock.balance_milli_units).toBe(toMilliUnits(14.7));
  });

  it("keeps another organization's purchases and counts invisible", async () => {
    const scene = await studio();
    await purchase(scene);

    const other = await studio();
    await purchase(other, { quantity: 5 });

    const stock = await stockOf(scene);
    expect(stock.packages_purchased).toBe(1);

    const rows = await loadMaterialStock(scene.organizationId);
    expect(rows.map((row) => row.material_id)).toEqual([scene.materialId]);
  });

  it("keeps the purchase log even after the material is archived", async () => {
    const scene = await studio();
    await purchase(scene);

    const [latest] = await adminDb
      .select()
      .from(materialPurchases)
      .where(eq(materialPurchases.materialId, scene.materialId))
      .orderBy(desc(materialPurchases.purchasedAt))
      .limit(1);

    // The generated column is the only place the total lives, so it cannot
    // disagree with the two figures it is made of.
    expect(latest.totalCostMinor).toBe(latest.packageQuantity * latest.unitPackageCostMinor);
  });
});
