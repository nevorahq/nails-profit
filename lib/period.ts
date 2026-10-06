import { and, eq, gte, isNull, lte } from "drizzle-orm";

import { chairRents, expenses, laborCostRules, organizations, ownerDraws, specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { buildCapacityView, type CapacityView } from "@/domain/capacity";
import { buildCashFlow, type CashFlow } from "@/domain/cash-flow";
import { chairRentTotalMinor, selectChairRents } from "@/domain/chair-rent";
import { isMaterialCategory } from "@/domain/expense-classes";
import { expensesForMonth, type PeriodExpenseRow } from "@/domain/expense-periods";
import { selectLaborRules } from "@/domain/labor-cost";
import { materialsModeFor, type MaterialsCostingMode } from "@/domain/materials-mode";
import { buildPeriodPL, type PeriodPL } from "@/domain/period-pl";
import type { AppLocale } from "@/i18n/messages";
import { loadMonthRota } from "@/lib/capacity";
import { loadDashboard } from "@/lib/dashboard";
import { loadMaterialsModes } from "@/lib/materials-mode";
import { loadPayoutReport } from "@/lib/payouts";

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
  /**
   * The chairs rented this month and what each is owed, beside the masters
   * above rather than among them: a renter's visits are not the studio's, so
   * the breakdown — the studio's visits by master — has nothing to say of them.
   */
  chairRents: readonly Readonly<{ specialistId: string; name: string; amountMinor: number }>[];
  /**
   * How the month counted its materials, and — counted per service — the two
   * figures that should roughly agree: what the visits took off their margins
   * by the amounts on services, and what was bought. Only the first is in the
   * profit; the second is cash only that month, so a gel pot is subtracted
   * once.
   */
  materials: Readonly<{
    mode: MaterialsCostingMode;
    perServiceMinor: number;
    purchasedMinor: number;
  }>;
}>;

export type MasterPeriodBreakdown = Readonly<{
  specialistId: string;
  name: string;
  visits: number;
  revenueMinor: number;
  compensationMinor: number;
  /** Left for this master by clients, on top of what they were paid for the work. */
  tipsMinor: number;
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
      tipsMinor: 0,
      rules: [],
    };
    // Every rule the visit paid under: one for a visit of one service, one per
    // rule for a visit whose services fell under different ones.
    const visitRules = row.lineRules ?? [
      {
        type: row.commissionType ?? "unknown",
        basisPoints: row.commissionBasisPoints ?? null,
        fixedAmountMinor: row.commissionFixedAmountMinor ?? null,
      },
    ];
    const keyOf = (item: MasterPeriodBreakdown["rules"][number]) =>
      `${item.type}:${item.basisPoints ?? ""}:${item.fixedAmountMinor ?? ""}`;
    const rules = [...existing.rules];
    for (const rule of visitRules) {
      if (!rules.some((item) => keyOf(item) === keyOf(rule))) rules.push(rule);
    }
    grouped.set(row.specialistId, {
      ...existing,
      visits: existing.visits + 1,
      revenueMinor: existing.revenueMinor + row.revenueMinor,
      compensationMinor: existing.compensationMinor + (row.commissionMinor ?? 0),
      tipsMinor: existing.tipsMinor + (row.tipMinor ?? 0),
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
   * The rents, versioned like the labour rules and read the same way — the
   * row that charges March may have been written a year before it.
   */
  const rentRows = await tx
    .select({
      id: chairRents.id,
      specialistId: chairRents.specialistId,
      amountMinor: chairRents.amountMinor,
      activeFrom: chairRents.activeFrom,
      activeTo: chairRents.activeTo,
      name: specialists.name,
    })
    .from(chairRents)
    .innerJoin(specialists, eq(specialists.id, chairRents.specialistId));
  const monthRents = selectChairRents(rentRows, options.month);
  const chairRentMinor = chairRentTotalMinor(monthRents);

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

  // The month's own mode, never today's: a month already reported keeps it.
  const materialsMode = materialsModeFor(
    (await loadMaterialsModes(tx, options.organizationId)).periods,
    options.month,
  );
  const monthExpenses = expensesForMonth(inCurrency, options.month, materialsMode);

  const pl = buildPeriodPL({
    month: options.month,
    metrics: dashboard.metrics,
    expenses: monthExpenses,
    laborRules: selectLaborRules(laborRows, options.month),
    withdrawalReserveMinor: organization?.withdrawalReserveMinor ?? 0,
    chairRentMinor,
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
  /*
   * What hired masters were actually handed, for a month inside the span the
   * studio keeps track of — null for every other month, which leaves the cash
   * flow reading their pay as gone the month it was earned.
   */
  const payouts = await loadPayoutReport(tx, { month: options.month, currency: options.currency, whenTracked: true }, locale);
  const payoutRows = payouts?.ledger.rows ?? [];

  const ownerDrawsMinor = draws
    .filter((row) => row.currency === options.currency)
    .reduce((total, row) => total + row.amountMinor, 0);

  return {
    pl,
    capacity: buildCapacityView({
      scheduledMinutes: rota.scheduledMinutes,
      practicalCapacityBasisPoints: organization?.practicalCapacityBasisPoints ?? 7500,
      bookedMinutes: dashboard.metrics.bookedDurationMinutes,
      // The visits' own, with the rent beside them: rent has no hours, so it
      // lowers what the visits must earn rather than joining their ratio.
      revenueMinor: pl.visitRevenueMinor,
      contributionMarginMinor: pl.contributionMarginMinor - pl.chairRentMinor,
      chairRentMinor: pl.chairRentMinor,
      principalLabourMinor: pl.principalLabourMinor,
      salariedLabourMinor: pl.salariedLabourMinor,
      overheadMinor: pl.overheadMinor,
      ownerWageMinor: pl.ownerWageMinor,
      operatingProfitMinor: pl.operatingProfitMinor,
    }),
    cashFlow: buildCashFlow({
      month: options.month,
      revenueMinor: pl.visitRevenueMinor,
      chairRentMinor: pl.chairRentMinor,
      paymentCommissionMinor: pl.paymentCommissionMinor,
      visitLabourMinor: pl.labourCostMinor,
      salariedLabourMinor: pl.salariedLabourMinor,
      expenses: monthExpenses,
      ownerDrawsMinor,
      tipsMinor: dashboard.metrics.tipsMinor,
      // A principal's tips stay on the account; a hired master's are handed on.
      tipsPaidOutMinor: dashboard.metrics.tipsMinor - dashboard.metrics.principalTipsMinor,
      operatingProfitMinor: pl.operatingProfitMinor,
      masterPayouts: payouts
        ? {
            paidMinor: payouts.ledger.totals.paidMinor,
            owedMinor: payouts.ledger.totals.closingMinor,
            commissionMinor: payoutRows.reduce((total, row) => total + row.commissionMinor, 0),
            wageMinor: payoutRows.reduce((total, row) => total + row.wageMinor, 0),
          }
        : undefined,
    }),
    currency: options.currency,
    excludedRows: rows.length - inCurrency.length,
    withdrawalReserveMinor: organization?.withdrawalReserveMinor ?? 0,
    masterBreakdown: buildMasterBreakdown(dashboard.rows),
    chairRents: monthRents
      .map((rent) => ({
        specialistId: rent.specialistId,
        name: rentRows.find((row) => row.id === rent.id)?.name ?? "—",
        amountMinor: rent.amountMinor,
      }))
      .sort((left, right) => right.amountMinor - left.amountMinor),
    materials: {
      mode: materialsMode,
      perServiceMinor: dashboard.metrics.materialsMinor,
      purchasedMinor: monthExpenses
        .filter((row) => isMaterialCategory(row.category))
        .reduce((total, row) => total + row.amountMinor, 0),
    },
  };
}
