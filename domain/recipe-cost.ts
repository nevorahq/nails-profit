import { materialCostMinor } from "@/domain/units";

/**
 * Turns a recipe into a material cost, spec CST-003 and CST-005.
 *
 * A line whose material has no usable purchase price makes the whole recipe
 * incomplete rather than cheaper: section 8.8.1 forbids treating an unknown
 * material cost as zero, and CST-010 needs the list of what is missing so the
 * user can be told which material to fill in.
 */

export type RecipeLinePrice = Readonly<{
  packagePriceMinor: number;
  packageSizeMilliUnits: number;
}>;

export type RecipeLine = Readonly<{
  materialId: string;
  quantityMilliUnits: number;
  /** Null when the material has no purchase price recorded at all. */
  price: RecipeLinePrice | null;
}>;

export type PricedRecipeLine = RecipeLine & Readonly<{ costMinor: number }>;

export type RecipeCost = Readonly<
  | {
      complete: true;
      materialCostMinor: number;
      lines: readonly PricedRecipeLine[];
    }
  | {
      complete: false;
      /** Materials whose price or package size is missing, in recipe order. */
      unpricedMaterialIds: readonly string[];
    }
>;

export function calculateRecipeCost(lines: readonly RecipeLine[]): RecipeCost {
  const unpricedMaterialIds: string[] = [];
  const priced: PricedRecipeLine[] = [];

  for (const line of lines) {
    const costMinor =
      line.price === null
        ? null
        : materialCostMinor(
            line.price.packagePriceMinor,
            line.price.packageSizeMilliUnits,
            line.quantityMilliUnits,
          );

    if (costMinor === null) {
      unpricedMaterialIds.push(line.materialId);
      continue;
    }
    priced.push({ ...line, costMinor });
  }

  // Reported even when only one line is unpriced. A partial sum would look like
  // a real material cost and quietly understate it.
  if (unpricedMaterialIds.length > 0) return { complete: false, unpricedMaterialIds };

  return {
    complete: true,
    materialCostMinor: priced.reduce((total, line) => total + line.costMinor, 0),
    lines: priced,
  };
}

/** An empty recipe costs nothing, which is different from an unknown cost. */
export function isEmptyRecipe(lines: readonly RecipeLine[]): boolean {
  return lines.length === 0;
}
