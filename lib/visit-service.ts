import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";

import {
  addOns,
  commissionRuleServices,
  commissionRules,
  consumptions,
  financialSnapshots,
  materialPriceVersions,
  materials,
  paymentMethods,
  recipeItems,
  recipes,
  services,
  specialists,
  taxRules,
  visitLines,
  visits,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { selectCommissionRule, toCommission } from "@/domain/commission";
import {
  CURRENT_FORMULA_VERSION,
  type Commission,
  type CommissionBase,
  type TaxRates,
} from "@/domain/costing";
import { hasAnyTax, selectTaxRates } from "@/domain/tax-rules";
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
  commission: {
    type: Commission["type"];
    basisPoints: number | null;
    fixedAmountMinor: number | null;
    base: CommissionBase;
    /**
     * The services the rule covers, empty when it covers all of them. Used to
     * mark each line commissionable at closing time, so a later edit of the
     * rule cannot change which lines a closed visit paid on.
     */
    serviceIds: readonly string[];
  } | null;
  currency: Currency;
  /**
   * The acquirer's terms, copied at closing time. Null when the visit was paid
   * in cash or when the studio has never entered a payment method — in both
   * cases there is no fee, and the visit costs what it always would have.
   */
  payment: { methodId: string; basisPoints: number; fixedFeeMinor: number } | null;
  /** The tax rules in force. Null when none of them would move a figure. */
  taxes: TaxRates | null;
  /**
   * Whether this specialist takes the residual profit rather than a wage. Part
   * of the snapshot for the same reason the commission rate is: the monthly
   * report adds a principal's commission back, and which months it applies to
   * must not change when the flag is switched later.
   */
  masterIsPrincipal: boolean;
  /** False when the service or a selected add-on has no saved recipe version. */
  standardUsageKnown: boolean;
}>;

/**
 * Previews a draft with the same domain function used after persistence.
 * Keeping this here prevents the calendar from growing a second, UI-only
 * profit formula that can drift from the financial snapshot.
 */
export function calculateVisitDraftProfit(draft: VisitDraft): VisitProfit | null {
  if (!draft.commission || draft.plannedDurationMinutes <= 0) return null;

  return calculateVisitProfit({
    currency: draft.currency,
    lines: draft.lines.map((line) => ({
      kind: line.kind,
      priceMinor: line.priceMinor,
      discountMinor: line.discountMinor,
      commissionable:
        draft.commission!.serviceIds.length === 0 ||
        draft.commission!.serviceIds.includes(line.serviceId ?? draft.lines[0]?.serviceId ?? ""),
    })),
    consumptions: draft.consumptions.map((line) => ({
      materialId: line.materialId,
      normativeQuantityMilliUnits: line.normativeQuantityMilliUnits,
      actualQuantityMilliUnits: null,
      packagePriceMinor: line.packagePriceMinorSnapshot,
      packageSizeMilliUnits: line.packageSizeMilliUnitsSnapshot,
    })),
    commission: toCommission({
      id: "draft",
      serviceId: null,
      type: draft.commission.type,
      basisPoints: draft.commission.basisPoints,
      fixedAmountMinor: draft.commission.fixedAmountMinor,
      activeFrom: new Date(0),
      activeTo: null,
    }),
    commissionBase: draft.commission.base,
    plannedDurationMinutes: draft.plannedDurationMinutes,
    actualDurationMinutes: null,
    standardUsageKnown: draft.standardUsageKnown,
    ...(draft.payment
      ? { payment: { basisPoints: draft.payment.basisPoints, fixedFeeMinor: draft.payment.fixedFeeMinor } }
      : {}),
    ...(draft.taxes ? { taxes: draft.taxes } : {}),
  });
}

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

  if (!recipe) return { configured: false as const, items: [] };

  const items = await tx
    .select({
      materialId: recipeItems.materialId,
      quantity: recipeItems.normativeQuantityMilliUnits,
      materialName: materials.name,
      baseUnit: materials.baseUnit,
    })
    .from(recipeItems)
    .innerJoin(materials, eq(recipeItems.materialId, materials.id))
    .where(eq(recipeItems.recipeId, recipe.id));

  return { configured: true as const, items };
}

/**
 * Turns a service, its chosen add-ons and a specialist into the rows a visit
 * will own. Quantities for a material used by both the service and an add-on
 * are summed here, so the visit carries one line per material and the cost is
 * rounded once.
 */
export async function buildVisitDraft(
  tx: TenantTransaction,
  input: {
    serviceId: string;
    addOnIds: readonly string[];
    specialistId: string;
    at: Date;
    /**
     * Chosen at closing time. Undefined falls back to the studio's default
     * method, and an explicit null means cash — which is how someone who
     * usually takes cards records the one client who paid in notes.
     */
    paymentMethodId?: string | null;
  },
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

  for (const source of recipeSources) {
    for (const item of source.items) {
      const existing = merged.get(item.materialId);
      if (existing) {
        merged.set(item.materialId, {
          ...existing,
          normativeQuantityMilliUnits: existing.normativeQuantityMilliUnits + item.quantity,
        });
        continue;
      }

      merged.set(item.materialId, {
        materialId: item.materialId,
        materialNameSnapshot: item.materialName,
        baseUnitSnapshot: item.baseUnit,
        normativeQuantityMilliUnits: item.quantity,
        // Null when nothing was on file at closing time. Never zero.
        packagePriceMinorSnapshot: null,
        packageSizeMilliUnitsSnapshot: null,
      });
    }
  }

  /*
   * One current-price query for the whole merged recipe. The previous loop did
   * one query per material, so a realistic manicure recipe closed with 10–15
   * avoidable round trips.
   */
  const materialIds = [...merged.keys()];
  const currentPrices =
    materialIds.length === 0
      ? []
      : await tx
          .selectDistinctOn([materialPriceVersions.materialId], {
            materialId: materialPriceVersions.materialId,
            packagePriceMinor: materialPriceVersions.packagePriceMinor,
            packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
          })
          .from(materialPriceVersions)
          .where(
            and(
              inArray(materialPriceVersions.materialId, materialIds),
              lte(materialPriceVersions.validFrom, input.at),
            ),
          )
          .orderBy(
            materialPriceVersions.materialId,
            desc(materialPriceVersions.validFrom),
            desc(materialPriceVersions.createdAt),
          );
  const priceByMaterial = new Map(currentPrices.map((price) => [price.materialId, price]));
  for (const [materialId, line] of merged) {
    const price = priceByMaterial.get(materialId);
    merged.set(materialId, {
      ...line,
      packagePriceMinorSnapshot: price?.packagePriceMinor ?? null,
      packageSizeMilliUnitsSnapshot: price?.packageSizeMilliUnits ?? null,
    });
  }

  const [person] = await tx
    .select({ isPrincipal: specialists.isPrincipal })
    .from(specialists)
    .where(eq(specialists.id, input.specialistId))
    .limit(1);

  const rules = await tx
    .select({
      id: commissionRules.id,
      serviceId: commissionRules.serviceId,
      type: commissionRules.type,
      basisPoints: commissionRules.basisPoints,
      fixedAmountMinor: commissionRules.fixedAmountMinor,
      base: commissionRules.base,
      activeFrom: commissionRules.activeFrom,
      activeTo: commissionRules.activeTo,
    })
    .from(commissionRules)
    .where(eq(commissionRules.specialistId, input.specialistId));

  const rule = selectCommissionRule(rules, service.id, input.at);

  // Which services the chosen rule covers. No rows means every service, which
  // is what every rule written before `commission_rule_service` existed does.
  const covered = rule
    ? (
        await tx
          .select({ serviceId: commissionRuleServices.serviceId })
          .from(commissionRuleServices)
          .where(eq(commissionRuleServices.commissionRuleId, rule.id))
      ).map((row) => row.serviceId)
    : [];

  /*
   * Explicit null means cash and is obeyed; undefined asks for the studio's
   * habit. A method the caller names that does not exist here — archived, or
   * another tenant's — finds nothing under RLS and the visit is costed as cash
   * rather than at a rate nobody agreed to.
   */
  const paymentMethod =
    input.paymentMethodId === null
      ? null
      : ((
          await tx
            .select({
              id: paymentMethods.id,
              commissionBasisPoints: paymentMethods.commissionBasisPoints,
              fixedFeeMinor: paymentMethods.fixedFeeMinor,
            })
            .from(paymentMethods)
            .where(
              input.paymentMethodId === undefined
                ? and(eq(paymentMethods.isDefault, true), isNull(paymentMethods.archivedAt))
                : eq(paymentMethods.id, input.paymentMethodId),
            )
            .limit(1)
        )[0] ?? null);

  const taxRows = await tx
    .select({
      kind: taxRules.kind,
      basisPoints: taxRules.basisPoints,
      remittable: taxRules.remittable,
      activeFrom: taxRules.activeFrom,
      activeTo: taxRules.activeTo,
    })
    .from(taxRules);
  const rates = selectTaxRates(taxRows, input.at);

  return {
    lines,
    consumptions: [...merged.values()],
    plannedDurationMinutes: lines.reduce((total, line) => total + line.durationMinutes, 0),
    commission: rule
      ? {
          type: rule.type,
          basisPoints: rule.basisPoints,
          fixedAmountMinor: rule.fixedAmountMinor,
          base: rule.base,
          serviceIds: covered,
        }
      : null,
    currency: (service.currency ?? "MDL") as Currency,
    masterIsPrincipal: person?.isPrincipal ?? false,
    standardUsageKnown: recipeSources.every((source) => source.configured),
    payment: paymentMethod
      ? {
          methodId: paymentMethod.id,
          basisPoints: paymentMethod.commissionBasisPoints,
          fixedFeeMinor: paymentMethod.fixedFeeMinor,
        }
      : null,
    // Null rather than four zeros: a stored row of zeros claims the taxes were
    // nil, and the absence of a row says nobody was asked.
    taxes: hasAnyTax(rates) ? rates : null,
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
  /** Omitted takes the studio's default method; explicit null means cash. */
  paymentMethodId?: string | null;
  consumption: readonly Readonly<{ materialId: string; actualQuantityMilliUnits: number }>[];
  requestId: string;
  /** Optional for server-to-server callers; the browser always sends one. */
  completionKey?: string;
  completionFingerprint?: string;
}>;

export type RecordVisitResult =
  | Readonly<{
      ok: true;
      visit: typeof visits.$inferSelect;
      snapshot: typeof financialSnapshots.$inferSelect;
      replayed: boolean;
    }>
  | Readonly<{ ok: false; failure: VisitFailure }>;

export type VisitFailure =
  | "service_not_found"
  | "missing_commission_rule"
  | "missing_duration"
  | "invalid_material_override"
  | "idempotency_conflict";

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
  invalid_material_override: {
    status: 422,
    code: "INVALID_MATERIAL_OVERRIDE",
    message: "A material override does not belong to this organization",
  },
  idempotency_conflict: {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "This completion key was already used for another visit",
  },
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
    paymentMethodId: input.paymentMethodId,
  });

  if (!draft) return { ok: false, failure: "service_not_found" };
  // Refusing beats recording a visit whose commission would read as zero.
  if (!draft.commission) return { ok: false, failure: "missing_commission_rule" };
  if (draft.plannedDurationMinutes <= 0) return { ok: false, failure: "missing_duration" };

  const actualByMaterial = new Map(
    input.consumption.map((entry) => [entry.materialId, entry.actualQuantityMilliUnits]),
  );

  /*
   * Validate and snapshot extra exception materials before writing the visit.
   * Returning a domain refusal after inserts would commit a partial visit,
   * because a refusal is data rather than a thrown transaction error.
   */
  const standardMaterialIds = new Set(draft.consumptions.map((line) => line.materialId));
  const extraMaterialIds = [...actualByMaterial.keys()].filter((id) => !standardMaterialIds.has(id));
  const extraMaterials =
    extraMaterialIds.length === 0
      ? []
      : await tx
          .select({ id: materials.id, name: materials.name, baseUnit: materials.baseUnit })
          .from(materials)
          .where(inArray(materials.id, extraMaterialIds));
  if (extraMaterials.length !== extraMaterialIds.length) {
    return { ok: false, failure: "invalid_material_override" };
  }

  const extraPrices =
    extraMaterialIds.length === 0
      ? []
      : await tx
          .selectDistinctOn([materialPriceVersions.materialId], {
            materialId: materialPriceVersions.materialId,
            packagePriceMinor: materialPriceVersions.packagePriceMinor,
            packageSizeMilliUnits: materialPriceVersions.packageSizeMilliUnits,
          })
          .from(materialPriceVersions)
          .where(
            and(
              inArray(materialPriceVersions.materialId, extraMaterialIds),
              lte(materialPriceVersions.validFrom, input.completedAt),
            ),
          )
          .orderBy(
            materialPriceVersions.materialId,
            desc(materialPriceVersions.validFrom),
            desc(materialPriceVersions.createdAt),
          );
  const extraPriceByMaterial = new Map(extraPrices.map((price) => [price.materialId, price]));
  const completionConsumptions: VisitDraftConsumption[] = [
    ...draft.consumptions,
    ...extraMaterials.map((material) => ({
      materialId: material.id,
      materialNameSnapshot: material.name,
      baseUnitSnapshot: material.baseUnit,
      normativeQuantityMilliUnits: 0,
      packagePriceMinorSnapshot: extraPriceByMaterial.get(material.id)?.packagePriceMinor ?? null,
      packageSizeMilliUnitsSnapshot: extraPriceByMaterial.get(material.id)?.packageSizeMilliUnits ?? null,
    })),
  ];

  const insertVisit = tx
    .insert(visits)
    .values({
      organizationId: input.organizationId,
      clientId: input.clientId,
      specialistId: input.specialistId,
      serviceId: input.serviceId,
      bookingId: input.bookingId ?? null,
      completionKey: input.completionKey ?? null,
      completionFingerprint: input.completionFingerprint ?? null,
      completedAt: input.completedAt,
      plannedDurationMinutes: draft.plannedDurationMinutes,
      actualDurationMinutes: input.actualDurationMinutes,
      commissionType: draft.commission.type,
      commissionBasisPoints: draft.commission.basisPoints,
      commissionFixedAmountMinor: draft.commission.fixedAmountMinor,
      commissionBase: draft.commission.base,
      currency: draft.currency,
      masterIsPrincipal: draft.masterIsPrincipal,
      standardMaterialUsageKnown: draft.standardUsageKnown,
      paymentMethodId: draft.payment?.methodId ?? null,
      paymentCommissionBasisPointsSnapshot: draft.payment?.basisPoints ?? null,
      paymentFixedFeeMinorSnapshot: draft.payment?.fixedFeeMinor ?? null,
      taxSnapshot: draft.taxes,
      createdBy: input.actor.userId,
      updatedBy: input.actor.userId,
    });
  const [visit] = input.completionKey
    ? await insertVisit.onConflictDoNothing().returning()
    : await insertVisit.returning();

  if (!visit) {
    const [existing] = await tx
      .select()
      .from(visits)
      .where(eq(visits.completionKey, input.completionKey!))
      .limit(1);
    if (!existing || existing.completionFingerprint !== input.completionFingerprint) {
      return { ok: false, failure: "idempotency_conflict" };
    }
    const [snapshot] = await tx
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, existing.id))
      .orderBy(desc(financialSnapshots.snapshotVersion))
      .limit(1);
    if (!snapshot) return { ok: false, failure: "idempotency_conflict" };
    return { ok: true, visit: existing, snapshot, replayed: true };
  }

  /*
   * Which lines the master's percentage applies to, decided once and stored.
   *
   * A rule that names no services covers everything. When it does name some,
   * an add-on rides on the service it was sold with: the client bought one
   * appointment, and paying the master for the manicure but not for the design
   * that came with it is not an arrangement anybody makes.
   */
  const covers = new Set(draft.commission.serviceIds);
  const commissionable = (line: VisitDraftLine) =>
    covers.size === 0 || covers.has(line.serviceId ?? input.serviceId);

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
      commissionable: commissionable(line),
      durationMinutes: line.durationMinutes,
      createdBy: input.actor.userId,
      updatedBy: input.actor.userId,
    })),
  );

  if (completionConsumptions.length > 0) {
    await tx.insert(consumptions).values(
      completionConsumptions.map((line) => ({
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

  return { ok: true, visit, snapshot, replayed: false };
}

/**
 * Answers `master_is_principal` for the visits that closed before anyone asked.
 *
 * The column arrived with migration 0025, so every visit closed before it holds
 * null — not "no", but "the question did not exist". The first time someone is
 * marked a principal, their own null rows are filled in: for those months this
 * person was already the owner working at the table, and the monthly report
 * would otherwise add back nothing for a year of their work.
 *
 * Rows that already hold true or false are left alone, so no closed visit ever
 * changes an answer it had — section 8.8.1 holds. Only the unknown becomes
 * known, and only once, which is why the caller runs this on the transition to
 * true rather than on every save.
 */
export async function adoptPrincipalHistory(tx: TenantTransaction, specialistId: string): Promise<number> {
  const filled = await tx
    .update(visits)
    .set({ masterIsPrincipal: true })
    .where(and(eq(visits.specialistId, specialistId), isNull(visits.masterIsPrincipal)))
    .returning({ id: visits.id });

  return filled.length;
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
    // The visit's own currency, never a constant: re-costing used to stamp
    // "MDL" here, so an organization on EUR had its first snapshot in EUR and
    // every correction afterwards in MDL.
    currency: visit.currency,
    lines: lines.map((line) => ({
      kind: line.kind === "add_on" ? ("add_on" as const) : ("service" as const),
      priceMinor: line.priceMinor,
      discountMinor: line.discountMinor,
      refundMinor: line.refundMinor,
      commissionable: line.commissionable,
    })),
    consumptions: snapshots,
    /*
     * Read off the visit, never resolved afresh. A studio that signs a cheaper
     * acquiring contract or meets a new VAT rate must not have last quarter
     * re-costed at today's terms the next time a visit is corrected — which is
     * the same reason the commission rule is copied in.
     */
    ...(visit.paymentCommissionBasisPointsSnapshot !== null
      ? {
          payment: {
            basisPoints: visit.paymentCommissionBasisPointsSnapshot,
            fixedFeeMinor: visit.paymentFixedFeeMinorSnapshot ?? 0,
          },
        }
      : {}),
    ...(visit.taxSnapshot ? { taxes: visit.taxSnapshot } : {}),
    // Null on a visit closed before the column existed, and read as
    // `after_discount` by the domain — which is what it was costed on.
    ...(visit.commissionBase ? { commissionBase: visit.commissionBase } : {}),
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
    standardUsageKnown: visit.standardMaterialUsageKnown,
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
  input: { organizationId: string; visitId: string; profit: VisitProfit; actorUserId: string },
) {
  const [previous] = await tx
    .select({ snapshotVersion: financialSnapshots.snapshotVersion })
    .from(financialSnapshots)
    .where(eq(financialSnapshots.visitId, input.visitId))
    .orderBy(desc(financialSnapshots.snapshotVersion))
    .limit(1);

  // Read here rather than accepted as an argument. Both callers used to pass a
  // literal "MDL", and a currency a caller supplies is a currency a caller can
  // get wrong — while the visit has always known its own.
  const [visit] = await tx
    .select({ currency: visits.currency })
    .from(visits)
    .where(eq(visits.id, input.visitId))
    .limit(1);

  const profit = input.profit;
  const common = {
    organizationId: input.organizationId,
    visitId: input.visitId,
    snapshotVersion: (previous?.snapshotVersion ?? 0) + 1,
    currency: visit.currency,
    revenueMinor: profit.revenueMinor,
    normativeMaterialCostMinor: profit.deviation.normativeCostMinor,
    materialUsageSource: profit.materialUsageSource,
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
            netRevenueMinor: profit.costing.netRevenueMinor,
            vatMinor: profit.costing.vatMinor,
            turnoverTaxMinor: profit.costing.turnoverTaxMinor,
            paymentCommissionMinor: profit.costing.paymentCommissionMinor,
            payrollTaxMinor: profit.costing.payrollTaxMinor,
            contributionMarginMinor: profit.costing.contributionMarginMinor,
            marginBasisPoints: profit.costing.marginBasisPoints,
            profitPerHourMinor: profit.costing.profitPerHourMinor,
            durationMinutes: profit.durationMinutes,
            estimatedDuration: profit.estimatedDuration,
            incompleteReasons: [],
          }
        : {
            ...common,
            formulaVersion: CURRENT_FORMULA_VERSION,
            incompleteReasons: [...profit.reasons],
          },
    )
    .returning();

  return snapshot;
}
