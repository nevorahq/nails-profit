import { and, desc, eq, gte, lte } from "drizzle-orm";

import { financialSnapshots, specialists, visitLines, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { aggregateVisitMetrics, type DashboardMetrics, type VisitMetricRow } from "@/domain/dashboard-metrics";
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
      materialCostMinor: financialSnapshots.materialCostMinor,
      normativeMaterialCostMinor: financialSnapshots.normativeMaterialCostMinor,
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
    })
    .from(financialSnapshots)
    .innerJoin(visits, eq(visits.id, financialSnapshots.visitId))
    .innerJoin(specialists, eq(specialists.id, visits.specialistId))
    .where(where)
    .orderBy(financialSnapshots.visitId, desc(financialSnapshots.snapshotVersion));

  const serviceLines = await tx
    .selectDistinctOn([visitLines.visitId], {
      visitId: visitLines.visitId,
      nameSnapshot: visitLines.nameSnapshot,
    })
    .from(visitLines)
    .innerJoin(visits, eq(visits.id, visitLines.visitId))
    .where(where ? and(where, eq(visitLines.kind, "service")) : eq(visitLines.kind, "service"))
    .orderBy(visitLines.visitId);

  const nameByVisit = new Map(serviceLines.map((line) => [line.visitId, line.nameSnapshot]));

  const rows: VisitMetricRow[] = snapshots
    // Newest visit first, as the per-visit read never guaranteed but the screen
    // has always shown.
    .sort((left, right) => right.completedAt.getTime() - left.completedAt.getTime())
    .map((snapshot) => {
      const nameSnapshot = nameByVisit.get(snapshot.visitId);
      return {
        visitId: snapshot.visitId,
        serviceId: snapshot.serviceId,
        // The name is read from the visit's own snapshot, so an archived or
        // renamed service still shows what was actually sold.
        serviceName: nameSnapshot
          ? (resolveLocalizedText(nameSnapshot, locale, locale) ?? "Без названия")
          : "Без названия",
        revenueMinor: snapshot.revenueMinor,
        commissionMinor: snapshot.commissionMinor,
        contributionMarginMinor: snapshot.contributionMarginMinor,
        materialCostMinor: snapshot.materialCostMinor,
        normativeMaterialCostMinor: snapshot.normativeMaterialCostMinor,
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
