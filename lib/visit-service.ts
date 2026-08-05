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
import type { MemberRole } from "@/domain/rbac";
import { calculateVisitProfit, type ConsumptionSnapshot, type VisitProfit } from "@/domain/visit-profit";
import { recordAuditEvent } from "@/lib/audit";
import { recordPilotProductEvent } from "@/lib/pilot-events";

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

export type RecordVisitInput = Readonly<{
  organizationId: string;
  actor: Readonly<{ userId: string; role: MemberRole }>;
  serviceId: string;
  specialistId: string;
  clientId: string | null;
  addOnIds: readonly string[];
  /** Set when the visit closes a booking, section 7.4. Null for a manual entry. */
  bookingId?: string | null;
  completedAt: Date;
  actualDurationMinutes: number | null;
  consumption: readonly Readonly<{ materialId: string; actualQuantityMilliUnits: number }>[];
  requestId: string;
}>;

export type RecordVisitResult =
  | Readonly<{
      ok: true;
      visit: typeof visits.$inferSelect;
      snapshot: typeof financialSnapshots.$inferSelect;
    }>
  | Readonly<{ ok: false; failure: VisitFailure }>;

export type VisitFailure = "service_not_found" | "missing_commission_rule" | "missing_duration";

/**
 * The envelope each refusal maps to, in one place so the manual flow and the
 * booking flow answer alike. Kept as data rather than as a `NextResponse` so
 * that this module stays free of the HTTP layer.
 */
export const VISIT_FAILURES: Readonly<
  Record<VisitFailure, Readonly<{ status: number; code: string; message: string }>>
> = {
  service_not_found: { status: 404, code: "SERVICE_NOT_FOUND", message: "No service with this ID" },
  missing_commission_rule: {
    status: 422,
    code: "MISSING_COMMISSION_RULE",
    message: "The specialist has no commission rule",
  },
  missing_duration: { status: 422, code: "MISSING_DURATION", message: "The service has no duration" },
};

/**
 * Closing a visit: the catalogue snapshot, the lines, the consumptions, the
 * financial snapshot and the events that follow from it.
 *
 * One function rather than one per caller. Gate 7 asks that "booking → visit →
 * profit даёт те же финансовые snapshots, что и ручной visit flow", and the
 * only way to guarantee two paths agree is for there to be one path. A booking
 * supplies the service, specialist and client it already knows; a manual entry
 * supplies them from a form.
 */
export async function recordCompletedVisit(
  tx: TenantTransaction,
  input: RecordVisitInput,
): Promise<RecordVisitResult> {
  const draft = await buildVisitDraft(tx, {
    serviceId: input.serviceId,
    addOnIds: input.addOnIds,
    specialistId: input.specialistId,
    at: input.completedAt,
  });

  if (!draft) return { ok: false, failure: "service_not_found" };
  // Refusing beats recording a visit whose commission would read as zero.
  if (!draft.commission) return { ok: false, failure: "missing_commission_rule" };
  if (draft.plannedDurationMinutes <= 0) return { ok: false, failure: "missing_duration" };

  const [visit] = await tx
    .insert(visits)
    .values({
      organizationId: input.organizationId,
      clientId: input.clientId,
      specialistId: input.specialistId,
      serviceId: input.serviceId,
      bookingId: input.bookingId ?? null,
      completedAt: input.completedAt,
      plannedDurationMinutes: draft.plannedDurationMinutes,
      actualDurationMinutes: input.actualDurationMinutes,
      commissionType: draft.commission.type,
      commissionBasisPoints: draft.commission.basisPoints,
      commissionFixedAmountMinor: draft.commission.fixedAmountMinor,
      createdBy: input.actor.userId,
      updatedBy: input.actor.userId,
    })
    .returning();

  await tx.insert(visitLines).values(
    draft.lines.map((line) => ({
      organizationId: input.organizationId,
      visitId: visit.id,
      kind: line.kind,
      serviceId: line.serviceId,
      addOnId: line.addOnId,
      nameSnapshot: line.nameSnapshot,
      priceMinor: line.priceMinor,
      discountMinor: line.discountMinor,
      durationMinutes: line.durationMinutes,
      createdBy: input.actor.userId,
      updatedBy: input.actor.userId,
    })),
  );

  const actualByMaterial = new Map(
    input.consumption.map((entry) => [entry.materialId, entry.actualQuantityMilliUnits]),
  );

  if (draft.consumptions.length > 0) {
    await tx.insert(consumptions).values(
      draft.consumptions.map((line) => ({
        organizationId: input.organizationId,
        visitId: visit.id,
        materialId: line.materialId,
        materialNameSnapshot: line.materialNameSnapshot,
        baseUnitSnapshot: line.baseUnitSnapshot,
        normativeQuantityMilliUnits: line.normativeQuantityMilliUnits,
        actualQuantityMilliUnits: actualByMaterial.get(line.materialId) ?? null,
        packagePriceMinorSnapshot: line.packagePriceMinorSnapshot,
        packageSizeMilliUnitsSnapshot: line.packageSizeMilliUnitsSnapshot,
        createdBy: input.actor.userId,
        updatedBy: input.actor.userId,
      })),
    );
  }

  const recalculated = await recalculateVisitProfit(tx, visit.id);
  const snapshot = await writeFinancialSnapshot(tx, {
    organizationId: input.organizationId,
    visitId: visit.id,
    profit: recalculated!.profit,
    currency: draft.currency,
    actorUserId: input.actor.userId,
  });

  await recordAuditEvent(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actor.userId,
    eventType: "visit.completed",
    entityType: "visit",
    entityId: visit.id,
    after: {
      revenue_minor: snapshot.revenueMinor,
      snapshot_version: snapshot.snapshotVersion,
      booking_id: input.bookingId ?? null,
    },
    requestId: input.requestId,
  });

  await recordPilotProductEvent(tx, {
    organizationId: input.organizationId,
    eventName: "visit_completed",
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    source: "api",
    entityType: "visit",
    entityId: visit.id,
    metadata: {
      complete_margin: snapshot.incompleteReasons.length === 0,
      from_booking: input.bookingId != null,
    },
  });

  // This mirrors `loadOnboarding`: the guided workflow is complete after the
  // first financial snapshot. Whether its margin is complete remains visible in
  // the visit event and is a separate Gate 6 financial-quality criterion.
  await recordPilotProductEvent(tx, {
    organizationId: input.organizationId,
    eventName: "onboarding_completed",
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    source: "api",
    entityType: "organization",
    entityId: input.organizationId,
  });

  return { ok: true, visit, snapshot };
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
