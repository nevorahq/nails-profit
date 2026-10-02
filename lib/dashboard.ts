import { and, desc, eq, gte, lte } from "drizzle-orm";

import { financialSnapshots, specialists, visitLines, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { toCommission } from "@/domain/commission";
import { aggregateVisitMetrics, type DashboardMetrics, type VisitMetricRow } from "@/domain/dashboard-metrics";
import { splitVisitByService, type SplitLine } from "@/domain/visit-split";
import { resolveLocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";

export type DashboardFilters = Readonly<{
  from?: Date;
  to?: Date;
  specialistId?: string | null;
}>;

/**
 * Studio Ledger figures, read from financial snapshots.
 *
 * Only the newest snapshot of each visit counts: a correction supersedes what
 * came before, and earlier versions stay for the audit trail. Summing every
 * version would double-count every corrected visit — which is exactly the kind
 * of quiet error Gate 3's "агрегаты сходятся с суммой snapshots" is there to
 * catch.
 */
export async function loadDashboard(
  tx: TenantTransaction,
  filters: DashboardFilters,
  locale: AppLocale,
): Promise<{ metrics: DashboardMetrics; rows: VisitMetricRow[] }> {
  const conditions = [
    filters.from ? gte(visits.completedAt, filters.from) : undefined,
    filters.to ? lte(visits.completedAt, filters.to) : undefined,
    filters.specialistId ? eq(visits.specialistId, filters.specialistId) : undefined,
  ].filter(Boolean);

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  /**
   * Three queries, not three per visit.
   *
   * `DISTINCT ON (visit_id) ... ORDER BY visit_id, snapshot_version DESC` is
   * the newest-version rule expressed once, in the place that can use the
   * unique index on (visit_id, snapshot_version). The per-visit loop this
   * replaces read a year of visits one round trip at a time, which is the
   * single reason a twelve-month dashboard took seconds rather than
   * milliseconds — section 15.1 allows two.
   */
  const snapshots = await tx
    .selectDistinctOn([financialSnapshots.visitId], {
      visitId: financialSnapshots.visitId,
      serviceId: visits.serviceId,
      revenueMinor: financialSnapshots.revenueMinor,
      commissionMinor: financialSnapshots.commissionMinor,
      contributionMarginMinor: financialSnapshots.contributionMarginMinor,
      vatMinor: financialSnapshots.vatMinor,
      turnoverTaxMinor: financialSnapshots.turnoverTaxMinor,
      payrollTaxMinor: financialSnapshots.payrollTaxMinor,
      paymentCommissionMinor: financialSnapshots.paymentCommissionMinor,
      durationMinutes: financialSnapshots.durationMinutes,
      // From the visit, not the snapshot: an incomplete costing carries no
      // duration, and capacity is about the chair rather than the margin.
      actualDurationMinutes: visits.actualDurationMinutes,
      plannedDurationMinutes: visits.plannedDurationMinutes,
      incompleteReasons: financialSnapshots.incompleteReasons,
      completedAt: visits.completedAt,
      masterIsPrincipal: visits.masterIsPrincipal,
      specialistId: visits.specialistId,
      specialistName: specialists.name,
      commissionType: visits.commissionType,
      commissionBasisPoints: visits.commissionBasisPoints,
      commissionFixedAmountMinor: visits.commissionFixedAmountMinor,
      commissionBase: visits.commissionBase,
      tipMinor: visits.tipMinor,
    })
    .from(financialSnapshots)
    .innerJoin(visits, eq(visits.id, financialSnapshots.visitId))
    .innerJoin(specialists, eq(specialists.id, visits.specialistId))
    .where(where)
    .orderBy(financialSnapshots.visitId, desc(financialSnapshots.snapshotVersion));

  /*
   * Every line, not one per visit: a visit of several services is split
   * between them in the ranking, and the split needs what each line charged,
   * which rule it was paid under and how long it was planned to take. Still
   * one query for the whole period.
   */
  const lines = await tx
    .select({
      visitId: visitLines.visitId,
      kind: visitLines.kind,
      serviceId: visitLines.serviceId,
      nameSnapshot: visitLines.nameSnapshot,
      priceMinor: visitLines.priceMinor,
      discountMinor: visitLines.discountMinor,
      refundMinor: visitLines.refundMinor,
      commissionable: visitLines.commissionable,
      commissionRuleId: visitLines.commissionRuleId,
      commissionType: visitLines.commissionType,
      commissionBasisPoints: visitLines.commissionBasisPoints,
      commissionFixedAmountMinor: visitLines.commissionFixedAmountMinor,
      commissionBase: visitLines.commissionBase,
      durationMinutes: visitLines.durationMinutes,
    })
    .from(visitLines)
    .innerJoin(visits, eq(visits.id, visitLines.visitId))
    .where(where)
    .orderBy(visitLines.visitId, visitLines.createdAt, visitLines.id);

  const linesByVisit = new Map<string, typeof lines>();
  for (const line of lines) {
    linesByVisit.set(line.visitId, [...(linesByVisit.get(line.visitId) ?? []), line]);
  }

  // The name is read from the visit's own snapshot, so an archived or renamed
  // service still shows what was actually sold.
  const nameOf = (nameSnapshot: Record<string, string> | null | undefined) =>
    nameSnapshot ? (resolveLocalizedText(nameSnapshot, locale, locale) ?? "Без названия") : "Без названия";

  const termsOf = (line: (typeof lines)[number]) =>
    line.commissionRuleId !== null && line.commissionType !== null && line.commissionBase !== null
      ? {
          ruleKey: line.commissionRuleId,
          commission: toCommission({
            id: line.commissionRuleId,
            serviceId: null,
            type: line.commissionType,
            basisPoints: line.commissionBasisPoints,
            fixedAmountMinor: line.commissionFixedAmountMinor,
            activeFrom: new Date(0),
            activeTo: null,
          }),
          base: line.commissionBase,
        }
      : null;

  // The rules a visit's lines name, once each; undefined when they name none,
  // which is every visit closed before rules moved onto lines.
  const distinctRules = (own: typeof lines) => {
    const seen = new Map<string, { type: string; basisPoints: number | null; fixedAmountMinor: number | null }>();
    for (const line of own) {
      if (line.commissionType === null) continue;
      const rule = {
        type: line.commissionType,
        basisPoints: line.commissionBasisPoints,
        fixedAmountMinor: line.commissionFixedAmountMinor,
      };
      seen.set(`${rule.type}:${rule.basisPoints ?? ""}:${rule.fixedAmountMinor ?? ""}`, rule);
    }
    return seen.size > 0 ? [...seen.values()] : undefined;
  };

  const rows: VisitMetricRow[] = snapshots
    // Newest visit first, as the per-visit read never guaranteed but the screen
    // has always shown.
    .sort((left, right) => right.completedAt.getTime() - left.completedAt.getTime())
    .map((snapshot) => {
      const own = linesByVisit.get(snapshot.visitId) ?? [];
      const serviceLines = own.filter((line) => line.kind === "service");
      const parts =
        snapshot.contributionMarginMinor !== null && new Set(serviceLines.map((line) => line.serviceId)).size > 1
          ? splitVisitByService(
              {
                revenueMinor: snapshot.revenueMinor,
                commissionMinor: snapshot.commissionMinor ?? 0,
                vatMinor: snapshot.vatMinor ?? 0,
                turnoverTaxMinor: snapshot.turnoverTaxMinor ?? 0,
                payrollTaxMinor: snapshot.payrollTaxMinor ?? 0,
                paymentCommissionMinor: snapshot.paymentCommissionMinor ?? 0,
                durationMinutes: snapshot.durationMinutes ?? 0,
              },
              own.map(
                (line): SplitLine => ({
                  serviceId: line.serviceId,
                  priceMinor: line.priceMinor,
                  discountMinor: line.discountMinor,
                  refundMinor: line.refundMinor,
                  commissionable: line.commissionable,
                  commissionTerms: termsOf(line),
                  durationMinutes: line.durationMinutes,
                }),
              ),
              {
                ruleKey: "visit",
                commission: toCommission({
                  id: snapshot.visitId,
                  serviceId: null,
                  type: snapshot.commissionType,
                  basisPoints: snapshot.commissionBasisPoints,
                  fixedAmountMinor: snapshot.commissionFixedAmountMinor,
                  activeFrom: new Date(0),
                  activeTo: null,
                }),
                base: snapshot.commissionBase ?? "after_discount",
              },
            )
          : null;
      return {
        visitId: snapshot.visitId,
        serviceId: snapshot.serviceId,
        serviceName:
          serviceLines.length > 0
            ? serviceLines.map((line) => nameOf(line.nameSnapshot)).join(" + ")
            : nameOf(null),
        lineRules: distinctRules(own),
        tipMinor: snapshot.tipMinor,
        serviceParts: parts?.map((part) => ({
          ...part,
          serviceName: nameOf(serviceLines.find((line) => line.serviceId === part.serviceId)?.nameSnapshot),
        })),
        revenueMinor: snapshot.revenueMinor,
        commissionMinor: snapshot.commissionMinor,
        contributionMarginMinor: snapshot.contributionMarginMinor,
        vatMinor: snapshot.vatMinor,
        turnoverTaxMinor: snapshot.turnoverTaxMinor,
        payrollTaxMinor: snapshot.payrollTaxMinor,
        paymentCommissionMinor: snapshot.paymentCommissionMinor,
        durationMinutes: snapshot.durationMinutes,
        workedMinutes: snapshot.actualDurationMinutes ?? snapshot.plannedDurationMinutes,
        incompleteReasons: snapshot.incompleteReasons ?? [],
        completedAt: snapshot.completedAt,
        masterIsPrincipal: snapshot.masterIsPrincipal,
        specialistId: snapshot.specialistId,
        specialistName: snapshot.specialistName,
        commissionType: snapshot.commissionType,
        commissionBasisPoints: snapshot.commissionBasisPoints,
        commissionFixedAmountMinor: snapshot.commissionFixedAmountMinor,
      };
    });

  return { metrics: aggregateVisitMetrics(rows), rows };
}

/** Specialists offered in the dashboard filter. */
export async function loadSpecialistOptions(tx: TenantTransaction) {
  return tx
    .select({ id: specialists.id, name: specialists.name })
    .from(specialists)
    .orderBy(specialists.name);
}
