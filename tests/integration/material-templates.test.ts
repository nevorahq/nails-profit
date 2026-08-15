import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { materialPriceVersions, materials, services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { createMaterialsFromTemplates, loadMaterialTemplates } from "@/lib/material-templates";
import { loadServiceCosting } from "@/lib/service-costing";
import { resetDatabase, seedMaterialTemplates } from "../helpers/database";
import {
  createCommissionRule,
  createOrganization,
  createRecipe,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The template catalogue against real rows: the claims that only hold if the
 * database and the costing engine agree with each other.
 */
describe("material templates over real data", () => {
  let organizationId: string;
  let userId: string;
  let specialistId: string;

  async function costing(serviceId: string) {
    return withTenant(organizationId, async (tx) => {
      const [service] = await tx.select().from(services).where(eq(services.id, serviceId));
      return loadServiceCosting(tx, service, { specialistId });
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedMaterialTemplates();
    const user = await createUser();
    userId = user.id;
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });
  });

  it("costs an aggregate exactly as it costs an SKU", async () => {
    // Built directly rather than from the catalogue: the fixed system list
    // offers no aggregates, but `material.kind` still carries the distinction
    // and the costing engine still has to ignore it.
    const [aggregate, sku] = await withTenant(organizationId, async (tx) => {
      const created = [];
      for (const [name, kind] of [
        ["Гель-лак цветной, средняя цена", "aggregate"],
        ["Гель-лак, одна банка", "sku"],
      ] as const) {
        const [material] = await tx
          .insert(materials)
          .values({
            organizationId,
            name,
            baseUnit: "ml",
            kind,
            createdBy: userId,
            updatedBy: userId,
          })
          .returning();
        await tx.insert(materialPriceVersions).values({
          organizationId,
          materialId: material.id,
          packagePriceMinor: 18_500,
          packageSizeMilliUnits: 8_000,
          currency: "MDL",
          createdBy: userId,
        });
        created.push(material);
      }
      return created;
    });

    expect(aggregate.kind).toBe("aggregate");
    expect(sku.kind).toBe("sku");

    const withAggregate = await createService(organizationId, {
      priceMinor: 60_000,
      durationMinutes: 90,
    });
    const withSku = await createService(organizationId, {
      priceMinor: 60_000,
      durationMinutes: 90,
    });
    await createRecipe(organizationId, withAggregate.id, [
      { materialId: aggregate.id, quantity: 0.6 },
    ]);
    await createRecipe(organizationId, withSku.id, [{ materialId: sku.id, quantity: 0.6 }]);

    const aggregateCosting = await costing(withAggregate.id);
    const skuCosting = await costing(withSku.id);

    if (aggregateCosting.status !== "complete" || skuCosting.status !== "complete") {
      throw new Error("expected both services to cost completely");
    }

    expect(aggregateCosting.costing).toEqual(skuCosting.costing);
    // 185.00 for 8 ml, 0.6 ml used — one rounding, at the end.
    expect(aggregateCosting.costing.materialCostMinor).toBe(1_388);
  });

  it("gives a service built from templates a margin and an hourly profit", async () => {
    const templates = await loadMaterialTemplates("ru", { coreOnly: true });

    const result = await withTenant(organizationId, (tx) =>
      createMaterialsFromTemplates(
        tx,
        { organizationId, userId },
        templates.map((template) => ({
          templateId: template.id,
          packagePriceMinor: 24_000,
          // The catalogue states no packaging, so the owner's figure is what
          // every cost from this material divides by.
          packageSizeMilliUnits: 15_000,
          currency: "MDL" as const,
        })),
      ),
    );

    expect(result.created).toBeGreaterThanOrEqual(12);

    const service = await createService(organizationId, {
      priceMinor: 60_000,
      durationMinutes: 90,
    });
    await createRecipe(
      organizationId,
      service.id,
      result.material_ids.slice(0, 5).map((materialId) => ({ materialId, quantity: 0.5 })),
    );

    const costed = await costing(service.id);

    expect(costed.status).toBe("complete");
    if (costed.status !== "complete") throw new Error("expected a complete costing");

    // Every line has a price, so nothing is treated as free and nothing is
    // missing — which is the whole point of a catalogue built by typing prices.
    expect(costed.costing.materialCostMinor).toBeGreaterThan(0);
    expect(costed.costing.contributionMarginMinor).toBeLessThan(60_000);
    expect(costed.costing.profitPerHourMinor).toBeGreaterThan(0);
    expect(costed.costing.commissionMinor).toBe(24_000);
  });


  it("prefers the size the owner entered over the catalogue's default", async () => {
    const [template] = await loadMaterialTemplates("ru", { coreOnly: true });
    expect(template.package_size_milli_units).toBeGreaterThan(0);

    const corrected = 12_000;
    expect(corrected).not.toBe(template.package_size_milli_units);

    await withTenant(organizationId, (tx) =>
      createMaterialsFromTemplates(tx, { organizationId, userId }, [
        {
          templateId: template.id,
          packagePriceMinor: 24_000,
          packageSizeMilliUnits: corrected,
          currency: "MDL",
        },
      ]),
    );

    const [version] = await withTenant(organizationId, (tx) =>
      tx.select().from(materialPriceVersions),
    );

    // The catalogue's figure is a starting point; the cost divides by the
    // package actually bought.
    expect(version.packageSizeMilliUnits).toBe(corrected);
  });

  it("falls back to the catalogue's size when the owner leaves it alone", async () => {
    const [template] = await loadMaterialTemplates("ru", { coreOnly: true });

    await withTenant(organizationId, (tx) =>
      createMaterialsFromTemplates(tx, { organizationId, userId }, [
        { templateId: template.id, packagePriceMinor: 24_000, currency: "MDL" },
      ]),
    );

    const [version] = await withTenant(organizationId, (tx) =>
      tx.select().from(materialPriceVersions),
    );

    expect(version.packageSizeMilliUnits).toBe(template.package_size_milli_units);
  });
});
