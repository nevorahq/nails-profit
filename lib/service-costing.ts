import { and, desc, eq, isNull, lte, or } from "drizzle-orm";

import {
  commissionRules,
  materialPriceVersions,
  materials,
  recipeItems,
  recipes,
  services,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { selectCommissionRule, toCommission } from "@/domain/commission";
import { calculateCosting, type CostingResult } from "@/domain/costing";
import { calculateRecipeCost, type RecipeLine } from "@/domain/recipe-cost";
import type { Currency } from "@/domain/money";

/**
 * Assembles a service costing out of stored data.
 *
 * `calculateCosting` stays strict — a missing price or a zero duration is a
 * programming error there and throws. Gaps in *data* are a different thing:
 * SRV-007 wants an unpriced service flagged, not rejected, so this layer checks
 * the preconditions first and reports what is missing. The engine is only called
 * once every input it needs actually exists.
 */
export type ServiceCostingReason =
  | "missing_price"
  | "missing_duration"
  | "missing_commission_rule"
  | "missing_recipe"
  | "missing_material_cost";

export type RecipeLineView = Readonly<{
  materialId: string;
  materialName: string;
  baseUnit: string;
  quantityMilliUnits: number;
  costMinor: number | null;
}>;

export type ServiceCosting = Readonly<
  | {
      status: "complete";
      currency: Currency;
      costing: Extract<CostingResult, { incompleteCostData: false }>;
      lines: readonly RecipeLineView[];
    }
  | {
      status: "incomplete";
      reasons: readonly ServiceCostingReason[];
      unpricedMaterialIds: readonly string[];
      lines: readonly RecipeLineView[];
    }
>;

/** The recipe in force for a service: the newest version effective by `at`. */
export async function loadActiveRecipe(tx: TenantTransaction, serviceId: string, at: Date = new Date()) {
  const [recipe] = await tx
    .select({ id: recipes.id, recipeVersion: recipes.recipeVersion })
    .from(recipes)
    // A version dated in the future is not in force yet. Without this filter a
    // scheduled recipe change would take effect the moment it was saved.
    .where(and(eq(recipes.serviceId, serviceId), lte(recipes.activeFrom, at)))
    .orderBy(desc(recipes.activeFrom), desc(recipes.recipeVersion))
    .limit(1);
  return recipe ?? null;
}

export async function loadRecipeLines(
  tx: TenantTransaction,
  recipeId: string,
): Promise<{ lines: RecipeLine[]; views: RecipeLineView[] }> {
  const rows = await tx
    .select({
      materialId: recipeItems.materialId,
      quantityMilliUnits: recipeItems.normativeQuantityMilliUnits,
      materialName: materials.name,
      baseUnit: materials.baseUnit,
    })
    .from(recipeItems)
    .innerJoin(materials, eq(recipeItems.materialId, materials.id))
    .where(eq(recipeItems.recipeId, recipeId))
    .orderBy(materials.name);

  const lines: RecipeLine[] = [];
  const views: RecipeLineView[] = [];

  for (const row of rows) {
    // The newest purchase price. CST-004 keeps every version, so this reads the
    // current one without touching history.
    const [price] = await tx
      .select({
        packagePriceMinor: materialPriceVersions.packagePriceMinor,
        packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
      })
      .from(materialPriceVersions)
      .where(eq(materialPriceVersions.materialId, row.materialId))
      .orderBy(desc(materialPriceVersions.validFrom), desc(materialPriceVersions.createdAt))
      .limit(1);

    lines.push({
      materialId: row.materialId,
      quantityMilliUnits: row.quantityMilliUnits,
      price: price ?? null,
    });
    views.push({
      materialId: row.materialId,
      materialName: row.materialName,
      baseUnit: row.baseUnit,
      quantityMilliUnits: row.quantityMilliUnits,
      costMinor: null,
    });
  }

  return { lines, views };
}

export async function loadServiceCosting(
  tx: TenantTransaction,
  service: typeof services.$inferSelect,
  options: { specialistId?: string | null; at?: Date } = {},
): Promise<ServiceCosting> {
  const at = options.at ?? new Date();
  const reasons: ServiceCostingReason[] = [];

  const recipe = await loadActiveRecipe(tx, service.id, at);
  const { lines, views } = recipe ? await loadRecipeLines(tx, recipe.id) : { lines: [], views: [] };
  const recipeCost = calculateRecipeCost(lines);

  if (service.priceMinor === null) reasons.push("missing_price");
  if (service.durationMinutes === null) reasons.push("missing_duration");
  // SRV-007. A service that has never had a recipe is not a service that costs
  // no materials — reporting it complete would hand back a margin computed as if
  // the materials were free, which is the exact failure this codebase refuses
  // everywhere else. A saved recipe with no items is a deliberate statement and
  // stays complete.
  if (!recipe) reasons.push("missing_recipe");
  if (!recipeCost.complete) reasons.push("missing_material_cost");

  let commission = null;
  if (options.specialistId) {
    const rules = await tx
      .select({
        id: commissionRules.id,
        serviceId: commissionRules.serviceId,
        type: commissionRules.type,
        basisPoints: commissionRules.basisPoints,
        fixedAmountMinor: commissionRules.fixedAmountMinor,
        activeFrom: commissionRules.activeFrom,
        activeTo: commissionRules.activeTo,
      })
      .from(commissionRules)
      .where(
        and(
          eq(commissionRules.specialistId, options.specialistId),
          or(isNull(commissionRules.serviceId), eq(commissionRules.serviceId, service.id)),
        ),
      );
    commission = selectCommissionRule(rules, service.id, at);
  }
  if (!commission) reasons.push("missing_commission_rule");

  const pricedByMaterial = new Map(
    recipeCost.complete ? recipeCost.lines.map((line) => [line.materialId, line.costMinor]) : [],
  );
  const detailedViews = views.map((view) => ({
    ...view,
    costMinor: pricedByMaterial.get(view.materialId) ?? null,
  }));

  // The last two conditions are implied by `reasons`, but spelling them out is
  // what lets TypeScript narrow `recipeCost` and `commission` below.
  if (reasons.length > 0 || !recipeCost.complete || !commission) {
    return {
      status: "incomplete",
      reasons,
      unpricedMaterialIds: recipeCost.complete ? [] : recipeCost.unpricedMaterialIds,
      lines: detailedViews,
    };
  }

  const currency = (service.currency ?? "MDL") as Currency;
  const costing = calculateCosting({
    priceMinor: service.priceMinor!,
    materialCostMinor: recipeCost.materialCostMinor,
    durationMinutes: service.durationMinutes!,
    currency,
    commission: toCommission(commission),
  });

  if (costing.incompleteCostData) {
    return {
      status: "incomplete",
      reasons: ["missing_material_cost"],
      unpricedMaterialIds: [],
      lines: detailedViews,
    };
  }

  return { status: "complete", currency, costing, lines: detailedViews };
}
