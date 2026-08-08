import { roundRatio } from "@/domain/money";

/**
 * Dashboard aggregates, spec section 8.9.1.
 *
 * Every figure comes from financial snapshots, never from the catalogue. That is
 * what Gate 3 means by "Owner видит одинаковую прибыль в визите и dashboard":
 * re-deriving totals from current prices would make the dashboard disagree with
 * its own visits the moment a supplier raised a price.
 */

export type VisitMetricRow = Readonly<{
  visitId: string;
  serviceId: string | null;
  serviceName: string;
  revenueMinor: number;
  commissionMinor: number | null;
  /** Null when the visit could not be costed; never read as zero. */
  contributionMarginMinor: number | null;
  materialCostMinor: number | null;
  normativeMaterialCostMinor: number | null;
  durationMinutes: number | null;
  incompleteReasons: readonly string[];
}>;

export type ServiceRanking = Readonly<{
  serviceId: string | null;
  serviceName: string;
  visits: number;
  revenueMinor: number;
  commissionMinor: number;
  contributionMarginMinor: number;
  marginBasisPoints: number | null;
  profitPerHourMinor: number | null;
}>;

export type DashboardMetrics = Readonly<{
  visits: number;
  /** Every completed visit in the period (section 8.9.1). */
  revenueMinor: number;
  /**
   * Split out on purpose. Dividing total margin by total revenue would mix
   * margin earned on costed visits with revenue from visits that have none,
   * and quietly understate the margin. The ratio uses this denominator; the
   * gap between the two is shown to the user instead of being averaged away.
   */
  costedVisits: number;
  costedRevenueMinor: number;
  contributionMarginMinor: number;
  marginBasisPoints: number | null;
  profitPerHourMinor: number | null;
  costedDurationMinutes: number;
  /** CST-007 at the level of a period: what the recipes said versus what was used. */
  normativeMaterialCostMinor: number;
  actualMaterialCostMinor: number;
  materialDeviationMinor: number;
  /** DSH-008: what stops the remaining visits from being costed. */
  incompleteVisits: number;
  incompleteRevenueMinor: number;
  incompleteReasonCounts: Readonly<Record<string, number>>;
  ranking: readonly ServiceRanking[];
}>;

function isCosted(row: VisitMetricRow): boolean {
  return row.contributionMarginMinor !== null;
}

export function aggregateVisitMetrics(rows: readonly VisitMetricRow[]): DashboardMetrics {
  const costed = rows.filter(isCosted);

  const revenueMinor = rows.reduce((total, row) => total + row.revenueMinor, 0);
  const costedRevenueMinor = costed.reduce((total, row) => total + row.revenueMinor, 0);
  const contributionMarginMinor = costed.reduce(
    (total, row) => total + (row.contributionMarginMinor ?? 0),
    0,
  );
  const costedDurationMinutes = costed.reduce((total, row) => total + (row.durationMinutes ?? 0), 0);

  const normativeMaterialCostMinor = costed.reduce(
    (total, row) => total + (row.normativeMaterialCostMinor ?? 0),
    0,
  );
  const actualMaterialCostMinor = costed.reduce((total, row) => total + (row.materialCostMinor ?? 0), 0);

  const incomplete = rows.filter((row) => !isCosted(row));
  const incompleteReasonCounts: Record<string, number> = {};
  for (const row of incomplete) {
    for (const reason of row.incompleteReasons) {
      incompleteReasonCounts[reason] = (incompleteReasonCounts[reason] ?? 0) + 1;
    }
  }

  return {
    visits: rows.length,
    revenueMinor,
    costedVisits: costed.length,
    costedRevenueMinor,
    contributionMarginMinor,
    // Section 8.9.1: total margin over total revenue, not the mean of per-visit
    // margins — a 20 MDL visit must not weigh as much as a 600 MDL one.
    marginBasisPoints:
      costedRevenueMinor === 0
        ? null
        : roundRatio(contributionMarginMinor * 10_000, costedRevenueMinor),
    profitPerHourMinor:
      costedDurationMinutes === 0
        ? null
        : roundRatio(contributionMarginMinor * 60, costedDurationMinutes),
    costedDurationMinutes,
    normativeMaterialCostMinor,
    actualMaterialCostMinor,
    materialDeviationMinor: actualMaterialCostMinor - normativeMaterialCostMinor,
    incompleteVisits: incomplete.length,
    incompleteRevenueMinor: incomplete.reduce((total, row) => total + row.revenueMinor, 0),
    incompleteReasonCounts,
    ranking: rankServices(costed),
  };
}

/**
 * DSH-005: services ranked by contribution margin, with profit per hour beside
 * it. The two orders differ — a long, high-margin service can earn less per hour
 * than a quick one — and seeing both is the point.
 */
function rankServices(costed: readonly VisitMetricRow[]): ServiceRanking[] {
  const groups = new Map<string, VisitMetricRow[]>();
  for (const row of costed) {
    const key = row.serviceId ?? `name:${row.serviceName}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()]
    .map((rows) => {
      const revenueMinor = rows.reduce((total, row) => total + row.revenueMinor, 0);
      const commissionMinor = rows.reduce((total, row) => total + (row.commissionMinor ?? 0), 0);
      const contributionMarginMinor = rows.reduce(
        (total, row) => total + (row.contributionMarginMinor ?? 0),
        0,
      );
      const durationMinutes = rows.reduce((total, row) => total + (row.durationMinutes ?? 0), 0);

      return {
        serviceId: rows[0].serviceId,
        serviceName: rows[0].serviceName,
        visits: rows.length,
        revenueMinor,
        commissionMinor,
        contributionMarginMinor,
        marginBasisPoints:
          revenueMinor === 0 ? null : roundRatio(contributionMarginMinor * 10_000, revenueMinor),
        profitPerHourMinor:
          durationMinutes === 0 ? null : roundRatio(contributionMarginMinor * 60, durationMinutes),
      };
    })
    .sort((a, b) => b.contributionMarginMinor - a.contributionMarginMinor);
}
