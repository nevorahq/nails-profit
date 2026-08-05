import { describe, expect, it } from "vitest";

import { calculateCosting } from "@/domain/costing";
import { calculateRecipeCost, type RecipeLine } from "@/domain/recipe-cost";
import { toMilliUnits } from "@/domain/units";

const gelPolish: RecipeLine = {
  materialId: "gel-polish",
  quantityMilliUnits: toMilliUnits(3),
  price: { packagePriceMinor: 24_000, packageSizeMilliUnits: toMilliUnits(15) },
};

const files: RecipeLine = {
  materialId: "files",
  quantityMilliUnits: toMilliUnits(2),
  price: { packagePriceMinor: 15_000, packageSizeMilliUnits: toMilliUnits(50) },
};

describe("calculateRecipeCost", () => {
  it("sums the lines of a fully priced recipe", () => {
    const result = calculateRecipeCost([gelPolish, files]);

    expect(result.complete).toBe(true);
    if (!result.complete) throw new Error("expected a complete recipe");
    // 3 ml of 240/15 = 48 MDL, plus 2 files of 150/50 = 6 MDL.
    expect(result.materialCostMinor).toBe(5_400);
    expect(result.lines.map((line) => line.costMinor)).toEqual([4_800, 600]);
  });

  it("costs an empty recipe at zero, which is not the same as unknown", () => {
    const result = calculateRecipeCost([]);
    expect(result.complete).toBe(true);
    if (!result.complete) throw new Error("expected a complete recipe");
    expect(result.materialCostMinor).toBe(0);
  });

  it("reports the recipe incomplete when a material has no price", () => {
    const result = calculateRecipeCost([gelPolish, { ...files, price: null }]);

    expect(result.complete).toBe(false);
    if (result.complete) throw new Error("expected an incomplete recipe");
    expect(result.unpricedMaterialIds).toEqual(["files"]);
    // The 48 MDL that could be costed is deliberately not reported: a partial
    // sum reads as a real material cost.
    expect(result).not.toHaveProperty("materialCostMinor");
  });

  it("reports a material with an unknown package size as unpriced", () => {
    const result = calculateRecipeCost([
      { ...gelPolish, price: { packagePriceMinor: 24_000, packageSizeMilliUnits: 0 } },
    ]);

    expect(result.complete).toBe(false);
    if (result.complete) throw new Error("expected an incomplete recipe");
    expect(result.unpricedMaterialIds).toEqual(["gel-polish"]);
  });

  it("lists every unpriced material, not just the first", () => {
    const result = calculateRecipeCost([
      { ...gelPolish, price: null },
      { ...files, price: null },
    ]);

    expect(result.complete).toBe(false);
    if (result.complete) throw new Error("expected an incomplete recipe");
    expect(result.unpricedMaterialIds).toEqual(["gel-polish", "files"]);
  });

  it("treats a genuinely free material as free, not as unknown", () => {
    const result = calculateRecipeCost([{ ...gelPolish, price: { ...gelPolish.price!, packagePriceMinor: 0 } }]);

    expect(result.complete).toBe(true);
    if (!result.complete) throw new Error("expected a complete recipe");
    expect(result.materialCostMinor).toBe(0);
  });
});

describe("recipe cost feeding the costing engine", () => {
  it("reproduces the Gate 2 canonical scenario from a recipe", () => {
    // Roadmap Gate 2: 600 MDL, 40% commission, 35 MDL of materials, 90 minutes.
    const recipe = calculateRecipeCost([
      {
        materialId: "gel-polish",
        quantityMilliUnits: toMilliUnits(2),
        price: { packagePriceMinor: 15_000, packageSizeMilliUnits: toMilliUnits(15) },
      },
      {
        materialId: "base",
        quantityMilliUnits: toMilliUnits(1),
        price: { packagePriceMinor: 15_000, packageSizeMilliUnits: toMilliUnits(10) },
      },
    ]);

    expect(recipe.complete).toBe(true);
    if (!recipe.complete) throw new Error("expected a complete recipe");
    expect(recipe.materialCostMinor).toBe(3_500);

    const costing = calculateCosting({
      priceMinor: 60_000,
      materialCostMinor: recipe.materialCostMinor,
      durationMinutes: 90,
      currency: "MDL",
      commission: { type: "percentage", basisPoints: 4_000 },
    });

    expect(costing).toMatchObject({
      incompleteCostData: false,
      commissionMinor: 24_000,
      contributionMarginMinor: 32_500,
      marginBasisPoints: 5_417,
      profitPerHourMinor: 21_667,
    });
  });

  it("carries recipe incompleteness through to the costing result", () => {
    const recipe = calculateRecipeCost([{ ...gelPolish, price: null }]);

    const costing = calculateCosting({
      priceMinor: 60_000,
      materialCostMinor: recipe.complete ? recipe.materialCostMinor : null,
      durationMinutes: 90,
      currency: "MDL",
      commission: { type: "percentage", basisPoints: 4_000 },
    });

    expect(costing.incompleteCostData).toBe(true);
    if (!costing.incompleteCostData) throw new Error("expected an incomplete costing");
    expect(costing.incompleteReasons).toEqual(["missing_material_cost"]);
  });
});
