import { and, eq, gte, isNull, lte } from "drizzle-orm";

import { expenses, laborCostRules, organizations, ownerDraws } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { buildCapacityView, type CapacityView } from "@/domain/capacity";
import { buildCashFlow, type CashFlow } from "@/domain/cash-flow";
import { expensesForMonth, type PeriodExpenseRow } from "@/domain/expense-periods";
import { selectLaborRules } from "@/domain/labor-cost";
import { buildPeriodPL, type PeriodPL } from "@/domain/period-pl";
import type { AppLocale } from "@/i18n/messages";
import { loadMonthRota } from "@/lib/capacity";
import { loadDashboard } from "@/lib/dashboard";

/**
 * The month's profit and loss, read from the two places it lives: the financial
 * snapshots of the visits, and the ledger.
 *
 * Built on `loadDashboard` rather than beside it. Gate 3 asks that the owner
 * see the same profit in a visit and in a report, and the only way two readers
 * are guaranteed to agree is for there to be one reader — this adds a single
 * query for the ledger and nothing else. It also inherits the three-query
 * shape that `tests/integration/dashboard-performance.test.ts` holds to a
 * time budget.
 */

export type PeriodReport = Readonly<{
  pl: PeriodPL;
  /**
   * What the rota made available and what that implies: utilization, the rate
   * fixed costs are spread at, break-even. Built beside the P&L rather than
   * inside it, so `buildPeriodPL` stays a statement of the month's money and
   * every capacity figure is testable without one.
   */
  capacity: CapacityView;
  /**
   * Where the money went, as opposed to where the profit went. Built beside the
   * P&L and never folded into it: the two answer different questions, and a
   * month where they disagree is the normal case rather than an error.
   */
  cashFlow: CashFlow;
  currency: string;
  /** Ledger rows in another currency, left out of every figure above. */
  excludedRows: number;
  /** Echoed back so the report can name the reserve it just subtracted. */
  withdrawalReserveMinor: number;
  masterBreakdown: readonly MasterPeriodBreakdown[];
}>;

export type MasterPeriodBreakdown = Readonly<{
  specialistId: string;
  name: string;
  visits: number;
  revenueMinor: number;
  compensationMinor: number;
  rules: readonly Readonly<{
    type: string;
    basisPoints: number | null;
    fixedAmountMinor: number | null;
  }>[];
}>;

function buildMasterBreakdown(rows: Awaited<ReturnType<typeof loadDashboard>>["rows"]): MasterPeriodBreakdown[] {
  const grouped = new Map<string, MasterPeriodBreakdown>();
  for (const row of rows) {
    if (!row.specialistId) continue;
    const existing = grouped.get(row.specialistId) ?? {
      specialistId: row.specialistId,
      name: row.specialistName ?? "—",
      visits: 0,
      revenueMinor: 0,
      compensationMinor: 0,
      rules: [],
    };
    const rule = {
      type: row.commissionType ?? "unknown",
      basisPoints: row.commissionBasisPoints ?? null,
      fixedAmountMinor: row.commissionFixedAmountMinor ?? null,
    };
    const ruleKey = `${rule.type}:${rule.basisPoints ?? ""}:${rule.fixedAmountMinor ?? ""}`;
    const rules = existing.rules.some(
      (item) => `${item.type}:${item.basisPoints ?? ""}:${item.fixedAmountMinor ?? ""}` === ruleKey,
    )
      ? existing.rules
      : [...existing.rules, rule];
    grouped.set(row.specialistId, {
      ...existing,
      visits: existing.visits + 1,
      revenueMinor: existing.revenueMinor + row.revenueMinor,
      compensationMinor: existing.compensationMinor + (row.commissionMinor ?? 0),
      rules,
    });
  }
  return [...grouped.values()].sort((left, right) => right.revenueMinor - left.revenueMinor);
}

/** `YYYY-MM` → the instants the month opens and closes, in UTC. */
export function monthBounds(month: string): { from: Date; to: Date } {
  const from = new Date(`${month}-01T00:00:00.000Z`);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + 1);
  to.setUTCMilliseconds(-1);
  return { from, to };
}

/** `YYYY-MM`, and a month that exists. */
export function isMonth(value: string | undefined): value is string {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}-01T00:00:00Z`).getTime());
}

/** The month a date falls in, as the report addresses it. */
export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export async function loadPeriodPL(
  tx: TenantTransaction,
  options: { month: string; currency: string; organizationId: string },
  locale: AppLocale,
): Promise<PeriodReport> {
  const { from, to } = monthBounds(options.month);
  const dashboard = await loadDashboard(tx, { from, to }, locale);
  /*
   * The whole live ledger, not the month's rows.
   *
   * A recurring row is stored once with an interval, so the row that pays
   * March's rent may have been written in January and carry a January
   * `spent_on`. Filtering by period in SQL would drop exactly the rows the
   * month depends on; `expensesForMonth` is what decides what belongs.
   */
  /*
   * The same reasoning for the labour rules: they are versioned by
   * `activeFrom`, so the rule that pays March's salary may have been written a
   * year earlier. `selectLaborRules` decides which one this month is on, and
   * takes one per person so that a raise does not pay two.
   */
  const laborRows = await tx
    .select({
      id: laborCostRules.id,
      recipient: laborCostRules.recipient,
      specialistId: laborCostRules.specialistId,
      label: laborCostRules.label,
      basis: laborCostRules.basis,
      amountMinor: laborCostRules.amountMinor,
      basisPoints: laborCostRules.basisPoints,
      payrollTaxBasisPoints: laborCostRules.payrollTaxBasisPoints,
      activeFrom: laborCostRules.activeFrom,
      activeTo: laborCostRules.activeTo,
    })
    .from(laborCostRules);

  /*
   * Filtered by id, unlike everything else read here.
   *
   * `organization` is the one table whose policy is `true` — it has no
   * `organization_id` to scope by, it *is* the organization — so the tenant
   * transaction does not narrow it and an unfiltered read would answer with
   * whichever row came first. Every other select on this page relies on RLS
   * and correctly says nothing about the tenant; this one has to say it.
   */
  const [organization] = await tx
    .select({
      withdrawalReserveMinor: organizations.withdrawalReserveMinor,
      practicalCapacityBasisPoints: organizations.practicalCapacityBasisPoints,
    })
    .from(organizations)
    .where(eq(organizations.id, options.organizationId))
    .limit(1);

  const rows = await tx
    .select({
      id: expenses.id,
      name: expenses.name,
      category: expenses.category,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
      spentOn: expenses.spentOn,
      isRecurring: expenses.isRecurring,
      recurringFrom: expenses.recurringFrom,
      recurringTo: expenses.recurringTo,
    })
    .from(expenses)
    // No organization filter: the transaction is already the tenant's, and RLS
    // is what scopes it — the same contract `lib/expenses.ts` reads under.
    .where(isNull(expenses.archivedAt));

  // One currency per report. The organization's currency can be changed and
  // nothing already recorded is converted, so rows in the old one are counted
  // out loud rather than added to the new — the same rule the ledger's own
  // totals follow.
  const inCurrency: PeriodExpenseRow[] = rows
    .filter((row) => row.currency === options.currency)
    .map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      amountMinor: row.amountMinor,
      spentOn: row.spentOn,
      isRecurring: row.isRecurring,
      recurringFrom: row.recurringFrom,
      recurringTo: row.recurringTo,
    }));

  const pl = buildPeriodPL({
    month: options.month,
    metrics: dashboard.metrics,
    expenses: expensesForMonth(inCurrency, options.month),
    laborRules: selectLaborRules(laborRows, options.month),
    withdrawalReserveMinor: organization?.withdrawalReserveMinor ?? 0,
  });

  const rota = await loadMonthRota(tx, options.month);

  /*
   * Draws are filtered by day in SQL, unlike the ledger above: they carry no
   * recurrence, so the day they happened is the whole answer.
   */
  const draws = await tx
    .select({ amountMinor: ownerDraws.amountMinor, currency: ownerDraws.currency })
    .from(ownerDraws)
    .where(
      and(
        gte(ownerDraws.occurredOn, from.toISOString().slice(0, 10)),
        lte(ownerDraws.occurredOn, to.toISOString().slice(0, 10)),
      ),
    );
  const ownerDrawsMinor = draws
    .filter((row) => row.currency === options.currency)
    .reduce((total, row) => total + row.amountMinor, 0);

  return {
    pl,
    capacity: buildCapacityView({
      scheduledMinutes: rota.scheduledMinutes,
      practicalCapacityBasisPoints: organization?.practicalCapacityBasisPoints ?? 7500,
      bookedMinutes: dashboard.metrics.bookedDurationMinutes,
      revenueMinor: pl.revenueMinor,
      contributionMarginMinor: pl.contributionMarginMinor,
      principalLabourMinor: pl.principalLabourMinor,
      salariedLabourMinor: pl.salariedLabourMinor,
      overheadMinor: pl.overheadMinor,
      ownerWageMinor: pl.ownerWageMinor,
      operatingProfitMinor: pl.operatingProfitMinor,
    }),
    cashFlow: buildCashFlow({
      month: options.month,
      revenueMinor: pl.revenueMinor,
      paymentCommissionMinor: pl.paymentCommissionMinor,
      visitLabourMinor: pl.labourCostMinor,
      salariedLabourMinor: pl.salariedLabourMinor,
      expenses: expensesForMonth(inCurrency, options.month),
      ownerDrawsMinor,
      operatingProfitMinor: pl.operatingProfitMinor,
    }),
    currency: options.currency,
    excludedRows: rows.length - inCurrency.length,
    withdrawalReserveMinor: organization?.withdrawalReserveMinor ?? 0,
    masterBreakdown: buildMasterBreakdown(dashboard.rows),
  };
}
