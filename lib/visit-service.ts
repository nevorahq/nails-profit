import { and, desc, eq, inArray, lte } from "drizzle-orm";

import {
  addOns,
  commissionRules,
  consumptions,
  financialSnapshots,
  materialPriceVersions,
  materials,
  recipeItems,
  recipes,
  services,
  visitLines,
  visits,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { selectCommissionRule, toCommission } from "@/domain/commission";
import type { Commission } from "@/domain/costing";
import type { Currency } from "@/domain/money";
import { calculateVisitProfit, type ConsumptionSnapshot, type VisitProfit } from "@/domain/visit-profit";

/**
 * Building and re-costing a visit.
 *
 * Everything the catalogue contributes is copied at closing time. After that the
 * visit is self-contained: re-costing it reads only its own rows, so a later
 * price change, recipe edit or commission change cannot reach it.
 */

export type VisitDraftLine = Readonly<{
  kind: "service" | "add_on";
  serviceId: string | null;
  addOnId: string | null;
  nameSnapshot: Record<string, string>;
  priceMinor: number;
  discountMinor: number;
  durationMinutes: number;
}>;

export type VisitDraftConsumption = Readonly<{
  materialId: string;
  materialNameSnapshot: string;
  baseUnitSnapshot: "ml" | "g" | "piece";
  normativeQuantityMilliUnits: number;
  packagePriceMinorSnapshot: number | null;
  packageSizeMilliUnitsSnapshot: number | null;
}>;

export type VisitDraft = Readonly<{
  lines: VisitDraftLine[];
  consumptions: VisitDraftConsumption[];
  plannedDurationMinutes: number;
  commission: { type: Commission["type"]; basisPoints: number | null; fixedAmountMinor: number | null } | null;
  currency: Currency;
}>;

async function activeRecipeItems(tx: TenantTransaction, target: { serviceId?: string; addOnId?: string }, at: Date) {
  const [recipe] = await tx
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        target.serviceId ? eq(recipes.serviceId, target.serviceId) : eq(recipes.addOnId, target.addOnId!),
        lte(recipes.activeFrom, at),
      ),
    )
    .orderBy(desc(recipes.activeFrom), desc(recipes.recipeVersion))
    .limit(1);

  if (!recipe) return [];

  return tx
    .select({
      materialId: recipeItems.materialId,
      quantity: recipeItems.normativeQuantityMilliUnits,
      materialName: materials.name,
      baseUnit: materials.baseUnit,
    })
    .from(recipeItems)
    .innerJoin(materials, eq(recipeItems.materialId, materials.id))
    .where(eq(recipeItems.recipeId, recipe.id));
}

/**
 * Turns a service, its chosen add-ons and a specialist into the rows a visit
 * will own. Quantities for a material used by both the service and an add-on
 * are summed here, so the visit carries one line per material and the cost is
 * rounded once.
 */
export async function buildVisitDraft(
  tx: TenantTransaction,
  input: { serviceId: string; addOnIds: readonly string[]; specialistId: string; at: Date },
): Promise<VisitDraft | null> {
  const [service] = await tx.select().from(services).where(eq(services.id, input.serviceId)).limit(1);
  if (!service) return null;

  const chosen =
    input.addOnIds.length > 0
      ? await tx.select().from(addOns).where(inArray(addOns.id, [...input.addOnIds]))
      : [];

  const lines: VisitDraftLine[] = [
    {
      kind: "service",
      serviceId: service.id,
      addOnId: null,
      nameSnapshot: (service.name ?? {}) as Record<string, string>,
      priceMinor: service.priceMinor ?? 0,
      discountMinor: 0,
      durationMinutes: service.durationMinutes ?? 0,
    },
    ...chosen.map((addOn) => ({
      kind: "add_on" as const,
      serviceId: null,
      addOnId: addOn.id,
      nameSnapshot: (addOn.name ?? {}) as Record<string, string>,
      priceMinor: Math.max(0, addOn.priceDeltaMinor),
      discountMinor: Math.max(0, -addOn.priceDeltaMinor),
      durationMinutes: addOn.durationDeltaMinutes,
    })),
  ];

  const merged = new Map<string, VisitDraftConsumption>();
  const recipeSources = [
    await activeRecipeItems(tx, { serviceId: service.id }, input.at),
    ...(await Promise.all(chosen.map((addOn) => activeRecipeItems(tx, { addOnId: addOn.id }, input.at)))),
  ];

  for (const items of recipeSources) {
    for (const item of items) {
      const existing = merged.get(item.materialId);
      if (existing) {
        merged.set(item.materialId, {
          ...existing,
          normativeQuantityMilliUnits: existing.normativeQuantityMilliUnits + item.quantity,
        });
        continue;
      }

      const [price] = await tx
        .select({
          packagePriceMinor: materialPriceVersions.packagePriceMinor,
          packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
        })
        .from(materialPriceVersions)
        .where(
          and(
            eq(materialPriceVersions.materialId, item.materialId),
            lte(materialPriceVersions.validFrom, input.at),
          ),
        )
        .orderBy(desc(materialPriceVersions.validFrom), desc(materialPriceVersions.createdAt))
        .limit(1);

      merged.set(item.materialId, {
        materialId: item.materialId,
        materialNameSnapshot: item.materialName,
        baseUnitSnapshot: item.baseUnit,
        normativeQuantityMilliUnits: item.quantity,
        // Null when nothing was on file at closing time. Never zero.
        packagePriceMinorSnapshot: price?.packagePriceMinor ?? null,
        packageSizeMilliUnitsSnapshot: price?.packageSizeMilliUnits ?? null,
      });
    }
  }

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
    .where(eq(commissionRules.specialistId, input.specialistId));

  const rule = selectCommissionRule(rules, service.id, input.at);

  return {
    lines,
    consumptions: [...merged.values()],
    plannedDurationMinutes: lines.reduce((total, line) => total + line.durationMinutes, 0),
    commission: rule
      ? { type: rule.type, basisPoints: rule.basisPoints, fixedAmountMinor: rule.fixedAmountMinor }
      : null,
    currency: (service.currency ?? "MDL") as Currency,
  };
}

/** Re-costs a stored visit from its own rows and nothing else. */
export async function recalculateVisitProfit(
  tx: TenantTransaction,
  visitId: string,
): Promise<{ visit: typeof visits.$inferSelect; profit: VisitProfit } | null> {
  const [visit] = await tx.select().from(visits).where(eq(visits.id, visitId)).limit(1);
  if (!visit) return null;

  const lines = await tx.select().from(visitLines).where(eq(visitLines.visitId, visit.id));
  const used = await tx.select().from(consumptions).where(eq(consumptions.visitId, visit.id));

  const snapshots: ConsumptionSnapshot[] = used.map((row) => ({
    materialId: row.materialId,
    normativeQuantityMilliUnits: row.normativeQuantityMilliUnits,
    actualQuantityMilliUnits: row.actualQuantityMilliUnits,
    packagePriceMinor: row.packagePriceMinorSnapshot,
    packageSizeMilliUnits: row.packageSizeMilliUnitsSnapshot,
  }));

  const profit = calculateVisitProfit({
    currency: "MDL",
    lines: lines.map((line) => ({
      kind: line.kind === "add_on" ? ("add_on" as const) : ("service" as const),
      priceMinor: line.priceMinor,
      discountMinor: line.discountMinor,
    })),
    consumptions: snapshots,
    commission: toCommission({
      id: visit.id,
      serviceId: null,
      type: visit.commissionType,
      basisPoints: visit.commissionBasisPoints,
      fixedAmountMinor: visit.commissionFixedAmountMinor,
      activeFrom: visit.completedAt,
      activeTo: null,
    }),
    plannedDurationMinutes: visit.plannedDurationMinutes,
    actualDurationMinutes: visit.actualDurationMinutes,
  });

  return { visit, profit };
}

/**
 * Writes the next financial snapshot version. Never updates: section 8.8.1
 * requires a correction to be a new version, and the database refuses anything
 * else anyway.
 */
export async function writeFinancialSnapshot(
  tx: TenantTransaction,
  input: { organizationId: string; visitId: string; profit: VisitProfit; currency: Currency; actorUserId: string },
) {
  const [previous] = await tx
    .select({ snapshotVersion: financialSnapshots.snapshotVersion })
    .from(financialSnapshots)
    .where(eq(financialSnapshots.visitId, input.visitId))
    .orderBy(desc(financialSnapshots.snapshotVersion))
    .limit(1);

  const profit = input.profit;
  const common = {
    organizationId: input.organizationId,
    visitId: input.visitId,
    snapshotVersion: (previous?.snapshotVersion ?? 0) + 1,
    currency: input.currency,
    revenueMinor: profit.revenueMinor,
    normativeMaterialCostMinor: profit.deviation.normativeCostMinor,
    createdBy: input.actorUserId,
  };

  // An incomplete visit still gets a snapshot: the revenue and the normative
  // cost are known, and CST-010 needs the row in order to list what is missing.
  // Every figure that depends on the unknown stays null rather than zero.
  const [snapshot] = await tx
    .insert(financialSnapshots)
    .values(
      profit.status === "complete"
        ? {
            ...common,
            formulaVersion: profit.costing.formulaVersion,
            materialCostMinor: profit.costing.materialCostMinor,
            commissionMinor: profit.costing.commissionMinor,
            contributionMarginMinor: profit.costing.contributionMarginMinor,
            marginBasisPoints: profit.costing.marginBasisPoints,
            profitPerHourMinor: profit.costing.profitPerHourMinor,
            durationMinutes: profit.durationMinutes,
            estimatedDuration: profit.estimatedDuration,
            incompleteReasons: [],
          }
        : {
            ...common,
            formulaVersion: "costing-v1",
            incompleteReasons: [...profit.reasons],
          },
    )
    .returning();

  return snapshot;
}
