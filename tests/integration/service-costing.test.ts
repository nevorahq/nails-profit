import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadServiceCosting } from "@/lib/service-costing";
import { resetDatabase } from "../helpers/database";
import {
  addMaterialPrice,
  createAddOn,
  createAddOnRecipe,
  createCommissionRule,
  createMaterial,
  createOrganization,
  createRecipe,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The assembly layer is where recipes, purchase prices, commission rules and the
 * engine meet, so it is where a regression is most likely and least visible.
 * Unit tests cannot reach it: every one of these facts depends on real queries.
 */
describe("service costing over real data", () => {
  let organizationId: string;
  let userId: string;
  let specialistId: string;

  async function costing(serviceId: string, options: { specialistId?: string | null; at?: Date } = {}) {
    return withTenant(organizationId, async (tx) => {
      const [service] = await tx.select().from(services).where(eq(services.id, serviceId));
      return loadServiceCosting(tx, service, {
        specialistId: options.specialistId === undefined ? specialistId : options.specialistId,
        at: options.at,
      });
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    userId = user.id;
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });
  });

  it("reproduces the roadmap Gate 2 scenario from stored rows", async () => {
    const gel = await createMaterial(organizationId, {
      name: "Гель-лак",
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const base = await createMaterial(organizationId, {
      name: "База",
      packagePriceMinor: 15_000,
      packageSize: 10,
      createdBy: userId,
    });
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    await createRecipe(organizationId, service.id, [
      { materialId: gel.id, quantity: 2 },
      { materialId: base.id, quantity: 1 },
    ]);

    const result = await costing(service.id);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected a complete costing");
    expect(result.costing).toMatchObject({
      materialCostMinor: 3_500,
      commissionMinor: 24_000,
      contributionMarginMinor: 32_500,
      marginBasisPoints: 5_417,
      profitPerHourMinor: 21_667,
    });
  });

  it("reports a service with no recipe as incomplete, not as free", async () => {
    const service = await createService(organizationId);

    const result = await costing(service.id);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("missing_recipe");
  });

  it("treats a saved empty recipe as a deliberate zero", async () => {
    const service = await createService(organizationId);
    await createRecipe(organizationId, service.id, []);

    const result = await costing(service.id);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.materialCostMinor).toBe(0);
  });

  it("refuses to cost a recipe containing a material with no price", async () => {
    const priced = await createMaterial(organizationId, {
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const unpriced = await createMaterial(organizationId, { name: "Без цены" });
    const service = await createService(organizationId);
    await createRecipe(organizationId, service.id, [
      { materialId: priced.id, quantity: 2 },
      { materialId: unpriced.id, quantity: 1 },
    ]);

    const result = await costing(service.id);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("missing_material_cost");
    expect(result.unpricedMaterialIds).toEqual([unpriced.id]);
  });

  it("names every missing input at once", async () => {
    const service = await createService(organizationId, { priceMinor: null, durationMinutes: null });

    const result = await costing(service.id, { specialistId: null });

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect([...result.reasons].sort()).toEqual(
      ["missing_commission_rule", "missing_duration", "missing_price", "missing_recipe"].sort(),
    );
  });

  it("reports a missing commission rule rather than costing it as zero", async () => {
    const material = await createMaterial(organizationId, {
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const service = await createService(organizationId);
    await createRecipe(organizationId, service.id, [{ materialId: material.id, quantity: 1 }]);

    const result = await costing(service.id, { specialistId: null });

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toEqual(["missing_commission_rule"]);
  });

  it("uses the newest purchase price without discarding the old one", async () => {
    // CST-004: history is append-only, and the current cost follows the latest.
    const material = await createMaterial(organizationId, {
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const service = await createService(organizationId);
    await createRecipe(organizationId, service.id, [{ materialId: material.id, quantity: 2 }]);

    const before = await costing(service.id);
    expect(before.status === "complete" && before.costing.materialCostMinor).toBe(2_000);

    await addMaterialPrice(organizationId, material.id, {
      packagePriceMinor: 30_000,
      packageSize: 15,
      createdBy: userId,
    });

    const after = await costing(service.id);
    expect(after.status === "complete" && after.costing.materialCostMinor).toBe(4_000);

    const versions = await withTenant(organizationId, async (tx) => {
      const { materialPriceVersions } = await import("@/db/schema");
      return tx.select().from(materialPriceVersions);
    });
    expect(versions).toHaveLength(2);
  });

  it("uses the newest recipe version and keeps the previous one", async () => {
    const gel = await createMaterial(organizationId, {
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const service = await createService(organizationId);
    await createRecipe(organizationId, service.id, [{ materialId: gel.id, quantity: 2 }], {
      recipeVersion: 1,
      activeFrom: new Date(Date.now() - 120_000),
    });
    await createRecipe(organizationId, service.id, [{ materialId: gel.id, quantity: 4 }], {
      recipeVersion: 2,
      activeFrom: new Date(Date.now() - 60_000),
    });

    const result = await costing(service.id);
    expect(result.status === "complete" && result.costing.materialCostMinor).toBe(4_000);

    const stored = await withTenant(organizationId, async (tx) => {
      const { recipes } = await import("@/db/schema");
      return tx.select().from(recipes);
    });
    expect(stored).toHaveLength(2);
  });

  it("ignores a recipe version dated in the future", async () => {
    const gel = await createMaterial(organizationId, {
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const service = await createService(organizationId);
    await createRecipe(organizationId, service.id, [{ materialId: gel.id, quantity: 2 }], {
      recipeVersion: 1,
      activeFrom: new Date(Date.now() - 60_000),
    });
    await createRecipe(organizationId, service.id, [{ materialId: gel.id, quantity: 10 }], {
      recipeVersion: 2,
      activeFrom: new Date(Date.now() + 86_400_000),
    });

    const result = await costing(service.id);
    // The scheduled version must not take effect the moment it is saved.
    expect(result.status === "complete" && result.costing.materialCostMinor).toBe(2_000);
  });

  it("prefers a per-service commission exception over the default", async () => {
    const material = await createMaterial(organizationId, {
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    await createRecipe(organizationId, service.id, [{ materialId: material.id, quantity: 2 }]);
    await createCommissionRule(organizationId, specialistId, {
      serviceId: service.id,
      basisPoints: 5_000,
    });

    const result = await costing(service.id);
    expect(result.status === "complete" && result.costing.commissionMinor).toBe(30_000);
  });

  it("does not rewrite history when a commission rule changes", async () => {
    // CST-009. Asking about a past date must still answer with the past rule.
    const material = await createMaterial(organizationId, {
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    await createRecipe(organizationId, service.id, [{ materialId: material.id, quantity: 2 }], {
      activeFrom: new Date("2026-01-01T00:00:00Z"),
    });

    const specialist = await createSpecialist(organizationId, { name: "Историк" });
    const cutover = new Date("2026-06-01T00:00:00Z");
    await createCommissionRule(organizationId, specialist.id, {
      basisPoints: 3_000,
      activeFrom: new Date("2026-01-01T00:00:00Z"),
      activeTo: cutover,
    });
    await createCommissionRule(organizationId, specialist.id, {
      basisPoints: 4_000,
      activeFrom: cutover,
    });

    const past = await costing(service.id, {
      specialistId: specialist.id,
      at: new Date("2026-03-01T00:00:00Z"),
    });
    const now = await costing(service.id, {
      specialistId: specialist.id,
      at: new Date("2026-08-01T00:00:00Z"),
    });

    expect(past.status === "complete" && past.costing.commissionMinor).toBe(18_000);
    expect(now.status === "complete" && now.costing.commissionMinor).toBe(24_000);
  });

  it("reports a loss-making service as a loss", async () => {
    const expensive = await createMaterial(organizationId, {
      packagePriceMinor: 25_000,
      packageSize: 1,
      createdBy: userId,
    });
    const service = await createService(organizationId, { priceMinor: 30_000, durationMinutes: 120 });
    await createRecipe(organizationId, service.id, [{ materialId: expensive.id, quantity: 1 }]);

    const result = await costing(service.id);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.contributionMarginMinor).toBeLessThan(0);
    expect(result.costing.marginBasisPoints).toBeLessThan(0);
    expect(result.costing.profitPerHourMinor).toBeLessThan(0);
  });

  it("never sees another organization's recipe", async () => {
    const other = await createOrganization({ name: "Other" });
    const otherMaterial = await createMaterial(other.id, {
      packagePriceMinor: 99_000,
      packageSize: 1,
      createdBy: userId,
    });
    const otherService = await createService(other.id);
    await createRecipe(other.id, otherService.id, [{ materialId: otherMaterial.id, quantity: 1 }]);

    // Reading the other tenant's service under our own context finds nothing at
    // all, so there is no costing to leak.
    const found = await withTenant(organizationId, (tx) =>
      tx.select().from(services).where(eq(services.id, otherService.id)),
    );
    expect(found).toEqual([]);
  });
});

/**
 * The roadmap lists "add-on с дополнительным временем и материалами" among the
 * mandatory phase 2 test cases. It is only meaningful against real rows: the
 * price and duration deltas, the add-on's own recipe and the merge of shared
 * materials all come from the database.
 */
describe("costing a service together with its add-ons", () => {
  let organizationId: string;
  let userId: string;
  let specialistId: string;
  let serviceId: string;
  let gelId: string;

  async function costing(addOnIds: string[]) {
    return withTenant(organizationId, async (tx) => {
      const [service] = await tx.select().from(services).where(eq(services.id, serviceId));
      return loadServiceCosting(tx, service, { specialistId, addOnIds });
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    userId = user.id;
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });

    const gel = await createMaterial(organizationId, {
      name: "Гель-лак",
      packagePriceMinor: 15_000,
      packageSize: 15,
      createdBy: userId,
    });
    gelId = gel.id;

    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    serviceId = service.id;
    await createRecipe(organizationId, service.id, [{ materialId: gel.id, quantity: 2 }]);
  });

  it("adds the price, the time and the materials of an add-on", async () => {
    const addOn = await createAddOn(organizationId, {
      priceDeltaMinor: 10_000,
      durationDeltaMinutes: 30,
    });
    await createAddOnRecipe(organizationId, addOn.id, [{ materialId: gelId, quantity: 1 }]);

    const withAddOn = await costing([addOn.id]);

    expect(withAddOn.status).toBe("complete");
    if (withAddOn.status !== "complete") throw new Error("expected complete");
    // 700 MDL, 40% commission, 3 ml of gel at 10 MDL/ml, 120 minutes.
    expect(withAddOn.costing).toMatchObject({
      priceMinor: 70_000,
      materialCostMinor: 3_000,
      commissionMinor: 28_000,
      contributionMarginMinor: 39_000,
    });
    expect(withAddOn.costing.profitPerHourMinor).toBe(19_500);
  });

  it("merges a shared material into one line rather than costing it twice", async () => {
    const addOn = await createAddOn(organizationId, { priceDeltaMinor: 0, durationDeltaMinutes: 0 });
    await createAddOnRecipe(organizationId, addOn.id, [{ materialId: gelId, quantity: 1 }]);

    const result = await costing([addOn.id]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    // One row for gel, holding 3 ml, not two rows of 2 ml and 1 ml.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].quantityMilliUnits).toBe(3_000);
  });

  it("applies a negative delta, since an add-on may shorten and discount", async () => {
    const addOn = await createAddOn(organizationId, {
      priceDeltaMinor: -10_000,
      durationDeltaMinutes: -30,
    });

    const result = await costing([addOn.id]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.priceMinor).toBe(50_000);
    // 60 minutes now, so the same margin is earned faster.
    expect(result.costing.profitPerHourMinor).toBe(28_000);
  });

  it("refuses to cost a set that drives the price below zero", async () => {
    const addOn = await createAddOn(organizationId, { priceDeltaMinor: -70_000 });

    const result = await costing([addOn.id]);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("negative_price_with_add_ons");
  });

  it("refuses to cost a set that leaves no duration", async () => {
    const addOn = await createAddOn(organizationId, { durationDeltaMinutes: -90 });

    const result = await costing([addOn.id]);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("invalid_duration_with_add_ons");
  });

  it("carries an unpriced add-on material through to the result", async () => {
    const unpriced = await createMaterial(organizationId, { name: "Без цены" });
    const addOn = await createAddOn(organizationId, {});
    await createAddOnRecipe(organizationId, addOn.id, [{ materialId: unpriced.id, quantity: 1 }]);

    const result = await costing([addOn.id]);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.unpricedMaterialIds).toEqual([unpriced.id]);
  });

  it("leaves the service unchanged when no add-on is selected", async () => {
    const addOn = await createAddOn(organizationId, { priceDeltaMinor: 10_000 });
    await createAddOnRecipe(organizationId, addOn.id, [{ materialId: gelId, quantity: 1 }]);

    const result = await costing([]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.priceMinor).toBe(60_000);
    expect(result.costing.materialCostMinor).toBe(2_000);
  });

  it("ignores an add-on id belonging to another organization", async () => {
    const other = await createOrganization({ name: "Other" });
    const foreign = await createAddOn(other.id, { priceDeltaMinor: 999_000 });

    const result = await costing([foreign.id]);

    // RLS hides the row, so the delta cannot reach our costing.
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.priceMinor).toBe(60_000);
  });
});
