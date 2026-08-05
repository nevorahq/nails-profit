import { and, eq, gte, lte, sql } from "drizzle-orm";

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

  const found = await tx
    .select({
      id: visits.id,
      serviceId: visits.serviceId,
    })
    .from(visits)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const rows: VisitMetricRow[] = [];

  for (const visit of found) {
    // DISTINCT ON would do this in one query; a per-visit read keeps the
    // "newest version wins" rule in one obvious place while pilot volumes are
    // small. Worth folding into SQL when a period actually gets slow.
    const [snapshot] = await tx
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, visit.id))
      .orderBy(sql`${financialSnapshots.snapshotVersion} desc`)
      .limit(1);

    if (!snapshot) continue;

    const [serviceLine] = await tx
      .select({ nameSnapshot: visitLines.nameSnapshot })
      .from(visitLines)
      .where(and(eq(visitLines.visitId, visit.id), eq(visitLines.kind, "service")))
      .limit(1);

    rows.push({
      visitId: visit.id,
      serviceId: visit.serviceId,
      // The name is read from the visit's own snapshot, so an archived or
      // renamed service still shows what was actually sold.
      serviceName: serviceLine
        ? (resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) ?? "Без названия")
        : "Без названия",
      revenueMinor: snapshot.revenueMinor,
      contributionMarginMinor: snapshot.contributionMarginMinor,
      materialCostMinor: snapshot.materialCostMinor,
      normativeMaterialCostMinor: snapshot.normativeMaterialCostMinor,
      durationMinutes: snapshot.durationMinutes,
      incompleteReasons: snapshot.incompleteReasons ?? [],
    });
  }

  return { metrics: aggregateVisitMetrics(rows), rows };
}

/** Specialists offered in the dashboard filter. */
export async function loadSpecialistOptions(tx: TenantTransaction) {
  return tx
    .select({ id: specialists.id, name: specialists.name })
    .from(specialists)
    .orderBy(specialists.name);
}
