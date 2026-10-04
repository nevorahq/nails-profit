import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import {
  addOns,
  commissionRuleServices,
  commissionRules,
  financialSnapshots,
  paymentMethods,
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
import { calculateVisitProfit, type VisitProfit } from "@/domain/visit-profit";
import type { CommissionTerms } from "@/domain/visit-commission";
import { applyPaidAmount, spreadDiscount, surchargeByService } from "@/domain/visit-payment";
import { supportedLocales } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { recordAuditEvent } from "@/lib/audit";
import { recordPilotProductEvent } from "@/lib/pilot-events";

/**
 * Building and re-costing a visit.
 *
 * Everything the catalogue contributes is copied at closing time. After that the
 * visit is self-contained: re-costing it reads only its own rows, so a later
 * price change or commission change cannot reach it.
 */

/** The commission rule a line is paid under, copied from the rule table. */
export type LineRule = Readonly<{
  id: string;
  type: Commission["type"];
  basisPoints: number | null;
  fixedAmountMinor: number | null;
  base: CommissionBase;
}>;

export type VisitDraftLine = Readonly<{
  /**
   * `surcharge` is what the client paid above the price list — a line of its
   * own, so the sticker price stays readable next to what the work fetched.
   */
  kind: "service" | "add_on" | "surcharge";
  /**
   * The service the line was sold with: its own on a service line, and the
   * service it rides on for an add-on or a surcharge. What a report needs to
   * attribute the line, and what the rule covering it was chosen for.
   */
  serviceId: string | null;
  addOnId: string | null;
  nameSnapshot: Record<string, string>;
  priceMinor: number;
  discountMinor: number;
  durationMinutes: number;
  /** Null only while the line's service has no rule, which refuses the visit. */
  rule: LineRule | null;
  /** Whether the rule's percentage applies to this line; see `recordCompletedVisit`. */
  commissionable: boolean;
}>;

export type VisitDraft = Readonly<{
  lines: VisitDraftLine[];
  plannedDurationMinutes: number;
  /**
   * The first service's rule, copied onto the visit itself as before — the
   * columns are required, and every reader written before a visit could hold
   * two services reads them. The costing reads the rule on each line. Null
   * when any service has no rule: a visit whose commission would read as zero
   * for part of it is refused, not recorded.
   */
  commission: {
    type: Commission["type"];
    basisPoints: number | null;
    fixedAmountMinor: number | null;
    base: CommissionBase;
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
}>;

/** The shape the costing engine takes a line's rule in. */
function termsOf(rule: LineRule): CommissionTerms {
  return {
    ruleKey: rule.id,
    commission: toCommission({
      id: rule.id,
      serviceId: null,
      type: rule.type,
      basisPoints: rule.basisPoints,
      fixedAmountMinor: rule.fixedAmountMinor,
      activeFrom: new Date(0),
      activeTo: null,
    }),
    base: rule.base,
  };
}

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
      commissionable: line.commissionable,
      commissionTerms: line.rule ? termsOf(line.rule) : null,
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
    ...(draft.payment
      ? { payment: { basisPoints: draft.payment.basisPoints, fixedFeeMinor: draft.payment.fixedFeeMinor } }
      : {}),
    ...(draft.taxes ? { taxes: draft.taxes } : {}),
  });
}

/** One service of a visit, with the add-ons chosen for it. */
export type VisitServiceItem = Readonly<{ serviceId: string; addOnIds: readonly string[] }>;

/**
 * Which services a visit is made of: a list, or the one service every caller
 * written before a visit could hold two still passes.
 */
export type VisitServices =
  | Readonly<{ items: readonly VisitServiceItem[] }>
  | Readonly<{ serviceId: string; addOnIds: readonly string[] }>;

function itemsOf(input: VisitServices): readonly VisitServiceItem[] {
  return "items" in input ? input.items : [{ serviceId: input.serviceId, addOnIds: input.addOnIds }];
}

/**
 * The prices a booking quoted, per service: the service itself, and each of its
 * add-ons by id.
 */
export type QuotedPrices = Readonly<{
  services: Readonly<
    Record<string, Readonly<{ priceMinor: number; addOnMinor: Readonly<Record<string, number>> }>>
  >;
}>;

type BookingLineLike = Readonly<{
  kind: string;
  serviceId: string | null;
  addOnId: string | null;
  priceMinor: number;
}>;

/**
 * Reads the services, their add-ons and the quote off a booking's own lines.
 *
 * The sum of the quote is the «Итого» the client saw on the booking, which is
 * what closing the appointment «по прайсу» records. Null when a service line no
 * longer names its catalogue row: the booking keeps its own name and price, but
 * a visit needs the commission rule behind them, and guessing which service it
 * used to be would be worse than refusing.
 *
 * An add-on line written before add-ons named their service belongs to the
 * first service — the only one a booking could hold then.
 */
export function bookingServicesOf(
  lines: readonly BookingLineLike[],
): { items: VisitServiceItem[]; quoted: QuotedPrices } | null {
  const serviceLines = lines.filter((line) => line.kind === "service");
  if (serviceLines.length === 0 || serviceLines.some((line) => !line.serviceId)) return null;

  const first = serviceLines[0].serviceId!;
  const items = serviceLines.map((line) => ({ serviceId: line.serviceId!, addOnIds: [] as string[] }));
  const quoted: Record<string, { priceMinor: number; addOnMinor: Record<string, number> }> = {};
  for (const line of serviceLines) quoted[line.serviceId!] = { priceMinor: line.priceMinor, addOnMinor: {} };

  for (const line of lines) {
    if (!line.addOnId) continue;
    const owner = line.serviceId && quoted[line.serviceId] ? line.serviceId : first;
    items.find((item) => item.serviceId === owner)!.addOnIds.push(line.addOnId);
    quoted[owner].addOnMinor[line.addOnId] = line.priceMinor;
  }

  return { items, quoted: { services: quoted } };
}

/** The surcharge line's name, in every language a snapshot may be read in. */
function surchargeName(): Record<string, string> {
  return Object.fromEntries(
    supportedLocales.map((locale) => [locale, getTranslator(locale)("visits.surcharge")]),
  );
}

/**
 * Turns the services, their chosen add-ons and a specialist into the rows a
 * visit will own.
 */
export async function buildVisitDraft(
  tx: TenantTransaction,
  input: VisitServices & {
    specialistId: string;
    at: Date;
    /**
     * Chosen at closing time. Undefined falls back to the studio's default
     * method, and an explicit null means cash — which is how someone who
     * usually takes cards records the one client who paid in notes.
     */
    paymentMethodId?: string | null;
    /**
     * The prices the client was quoted, when the visit closes a booking. The
     * booking already told the client what the appointment costs, and a price
     * list raised in the meantime must not bill them the new figure.
     */
    quoted?: QuotedPrices;
    /** What the client actually paid. Undefined means the price list (or the quote). */
    paidMinor?: number;
  },
): Promise<VisitDraft | null> {
  const items = itemsOf(input);
  if (items.length === 0) return null;

  const serviceIds = [...new Set(items.map((item) => item.serviceId))];
  const found = await tx.select().from(services).where(inArray(services.id, serviceIds));
  if (found.length !== serviceIds.length) return null;
  const serviceById = new Map(found.map((service) => [service.id, service]));

  const addOnIds = [...new Set(items.flatMap((item) => item.addOnIds))];
  const addOnRows = addOnIds.length > 0 ? await tx.select().from(addOns).where(inArray(addOns.id, addOnIds)) : [];
  const addOnById = new Map(addOnRows.map((addOn) => [addOn.id, addOn]));

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

  // Each service's own rule: an exception for the pedicure is the pedicure's,
  // whatever else was done in the same visit.
  const ruleByService = new Map(
    serviceIds.map((serviceId) => [serviceId, selectCommissionRule(rules, serviceId, input.at)]),
  );

  // Which services each chosen rule covers. No rows means every service, which
  // is what every rule written before `commission_rule_service` existed does.
  const ruleIds = [
    ...new Set([...ruleByService.values()].filter((rule) => rule !== null).map((rule) => rule!.id)),
  ];
  const coverage =
    ruleIds.length > 0
      ? await tx
          .select({
            ruleId: commissionRuleServices.commissionRuleId,
            serviceId: commissionRuleServices.serviceId,
          })
          .from(commissionRuleServices)
          .where(inArray(commissionRuleServices.commissionRuleId, ruleIds))
      : [];

  /*
   * Which lines the master's percentage applies to, decided once and stored.
   *
   * A rule that names no services covers everything. When it does name some,
   * an add-on rides on the service it was sold with: the client bought one
   * appointment, and paying the master for the manicure but not for the design
   * that came with it is not an arrangement anybody makes.
   */
  const covers = (serviceId: string) => {
    const rule = ruleByService.get(serviceId);
    if (!rule) return false;
    const named = coverage.filter((row) => row.ruleId === rule.id);
    return named.length === 0 || named.some((row) => row.serviceId === serviceId);
  };

  const ruleOf = (serviceId: string): LineRule | null => {
    const rule = ruleByService.get(serviceId);
    return rule
      ? {
          id: rule.id,
          type: rule.type,
          basisPoints: rule.basisPoints,
          fixedAmountMinor: rule.fixedAmountMinor,
          base: rule.base,
        }
      : null;
  };

  const lineOf = (
    serviceId: string,
    line: Pick<VisitDraftLine, "kind" | "addOnId" | "nameSnapshot" | "priceMinor" | "durationMinutes">,
  ): VisitDraftLine => ({
    ...line,
    serviceId,
    discountMinor: 0,
    rule: ruleOf(serviceId),
    commissionable: covers(serviceId),
  });

  const discounted: VisitDraftLine[] = [];
  for (const item of items) {
    const service = serviceById.get(item.serviceId)!;
    const quote = input.quoted?.services[service.id];
    const chosen = item.addOnIds.map((id) => addOnById.get(id)).filter((addOn) => addOn !== undefined);

    const priced: VisitDraftLine[] = [
      lineOf(service.id, {
        kind: "service",
        addOnId: null,
        nameSnapshot: (service.name ?? {}) as Record<string, string>,
        priceMinor: quote?.priceMinor ?? service.priceMinor ?? 0,
        durationMinutes: service.durationMinutes ?? 0,
      }),
      ...chosen.map((addOn) =>
        lineOf(service.id, {
          kind: "add_on",
          addOnId: addOn.id,
          nameSnapshot: (addOn.name ?? {}) as Record<string, string>,
          priceMinor: quote?.addOnMinor[addOn.id] ?? Math.max(0, addOn.priceDeltaMinor),
          durationMinutes: addOn.durationDeltaMinutes,
        }),
      ),
    ];

    /*
     * An add-on that makes the visit cheaper — a short length — is a discount
     * on what its service charges, not a line of its own.
     *
     * It used to be written as a zero-price line carrying the whole reduction
     * as its discount, which the `visit_line_discount_within_price` check
     * refuses: closing any visit with such an add-on failed with a 500. Spread
     * over the priced lines of its own service instead, the reduction lands
     * where a discount can be taken from, and `full_price` commission still
     * ignores it exactly as it did.
     *
     * Not applied to a quote: the booking already decided what each line costs.
     */
    const reduction = input.quoted
      ? 0
      : chosen.reduce((total, addOn) => total + Math.max(0, -addOn.priceDeltaMinor), 0);
    discounted.push(...spreadDiscount(priced, reduction));
  }

  const paid = input.paidMinor === undefined ? null : applyPaidAmount(discounted, input.paidMinor);
  const lines: VisitDraftLine[] = paid ? [...paid.lines] : discounted;
  if (paid && paid.surchargeMinor > 0) {
    // Split between the services in proportion to what each charges, and each
    // part rides on its own service — so a rule that pays only on some
    // services pays on its part exactly when it pays on the service.
    for (const part of surchargeByService(discounted, paid.surchargeMinor)) {
      lines.push(
        lineOf(part.serviceId, {
          kind: "surcharge",
          addOnId: null,
          nameSnapshot: surchargeName(),
          priceMinor: part.amountMinor,
          durationMinutes: 0,
        }),
      );
    }
  }

  const [person] = await tx
    .select({ isPrincipal: specialists.isPrincipal })
    .from(specialists)
    .where(eq(specialists.id, input.specialistId))
    .limit(1);

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

  const firstService = serviceById.get(items[0].serviceId)!;
  const firstRule = ruleByService.get(firstService.id);
  const everyServiceHasRule = serviceIds.every((serviceId) => ruleByService.get(serviceId) !== null);

  return {
    lines,
    plannedDurationMinutes: lines.reduce((total, line) => total + line.durationMinutes, 0),
    commission:
      firstRule && everyServiceHasRule
        ? {
            type: firstRule.type,
            basisPoints: firstRule.basisPoints,
            fixedAmountMinor: firstRule.fixedAmountMinor,
            base: firstRule.base,
          }
        : null,
    currency: (firstService.currency ?? "MDL") as Currency,
    masterIsPrincipal: person?.isPrincipal ?? false,
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

export type RecordVisitInput = VisitServices &
  Readonly<{
    organizationId: string;
    actor: Readonly<{ userId: string; role: MemberRole }>;
    specialistId: string;
    clientId: string | null;
    /** Set when the visit closes a booking, section 7.4. Null for a manual entry. */
    bookingId?: string | null;
    completedAt: Date;
    actualDurationMinutes: number | null;
    /** Omitted takes the studio's default method; explicit null means cash. */
    paymentMethodId?: string | null;
    /** The booking's own prices, when the visit closes one. */
    quoted?: QuotedPrices;
    /** What the client actually paid; omitted means the price list or the quote. */
    paidMinor?: number;
    /** What the client left on top, the master's whole. Omitted means none. */
    tipMinor?: number;
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
  idempotency_conflict: {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "This completion key was already used for another visit",
  },
};

/**
 * Closing a visit: the catalogue snapshot, the lines, the financial snapshot
 * and the events that follow from it.
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
  const items = itemsOf(input);
  const draft = await buildVisitDraft(tx, {
    items,
    specialistId: input.specialistId,
    at: input.completedAt,
    paymentMethodId: input.paymentMethodId,
    quoted: input.quoted,
    paidMinor: input.paidMinor,
  });

  if (!draft) return { ok: false, failure: "service_not_found" };
  // Refusing beats recording a visit whose commission would read as zero.
  if (!draft.commission) return { ok: false, failure: "missing_commission_rule" };
  if (draft.plannedDurationMinutes <= 0) return { ok: false, failure: "missing_duration" };

  const insertVisit = tx
    .insert(visits)
    .values({
      organizationId: input.organizationId,
      clientId: input.clientId,
      specialistId: input.specialistId,
      // The first service, as the one a visit used to hold: what every reader
      // written before a visit could hold two goes on reading.
      serviceId: items[0].serviceId,
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
      paymentMethodId: draft.payment?.methodId ?? null,
      paymentCommissionBasisPointsSnapshot: draft.payment?.basisPoints ?? null,
      paymentFixedFeeMinorSnapshot: draft.payment?.fixedFeeMinor ?? null,
      taxSnapshot: draft.taxes,
      tipMinor: input.tipMinor ?? 0,
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
      commissionable: line.commissionable,
      // Every line has its rule once the draft has a commission at all.
      commissionRuleId: line.rule!.id,
      commissionType: line.rule!.type,
      commissionBasisPoints: line.rule!.basisPoints,
      commissionFixedAmountMinor: line.rule!.fixedAmountMinor,
      commissionBase: line.rule!.base,
      durationMinutes: line.durationMinutes,
      createdBy: input.actor.userId,
      updatedBy: input.actor.userId,
    })),
  );

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
      tip_minor: visit.tipMinor,
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

  const profit = calculateVisitProfit({
    // The visit's own currency, never a constant: re-costing used to stamp
    // "MDL" here, so an organization on EUR had its first snapshot in EUR and
    // every correction afterwards in MDL.
    currency: visit.currency,
    lines: lines.map((line) => ({
      kind:
        line.kind === "add_on" || line.kind === "surcharge"
          ? line.kind
          : ("service" as const),
      priceMinor: line.priceMinor,
      discountMinor: line.discountMinor,
      refundMinor: line.refundMinor,
      commissionable: line.commissionable,
      // Null on every line closed before rules moved onto lines: it then falls
      // under the visit's rule below, which is what it was costed on.
      commissionTerms:
        line.commissionRuleId !== null && line.commissionType !== null && line.commissionBase !== null
          ? termsOf({
              id: line.commissionRuleId,
              type: line.commissionType,
              basisPoints: line.commissionBasisPoints,
              fixedAmountMinor: line.commissionFixedAmountMinor,
              base: line.commissionBase,
            })
          : null,
    })),
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
    // Read off the visit like everything else here: a tip corrected later is a
    // new snapshot whose acquirer's fee follows it.
    tipMinor: visit.tipMinor,
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
    createdBy: input.actorUserId,
  };

  // An incomplete visit still gets a snapshot: the revenue is known, and
  // CST-010 needs the row in order to list what is missing. Every figure that
  // depends on the unknown stays null rather than zero.
  const [snapshot] = await tx
    .insert(financialSnapshots)
    .values(
      profit.status === "complete"
        ? {
            ...common,
            formulaVersion: profit.costing.formulaVersion,
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
