import { asc, eq } from "drizzle-orm";

import { laborCostRules, masterPayouts, specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { monthlyWageMinor, selectLaborRules } from "@/domain/labor-cost";
import {
  buildPayoutLedger,
  monthsBetween,
  payoutStartMonth,
  shiftMonth,
  type MasterAccrual,
  type PayoutLedger,
} from "@/domain/payouts";
import type { AppLocale } from "@/i18n/messages";
import { loadDashboard } from "@/lib/dashboard";

export type PayoutEntry = Readonly<{
  id: string;
  specialistId: string;
  amountMinor: number;
  paidOn: string;
  note: string | null;
}>;

export type PayoutReport = Readonly<{
  ledger: PayoutLedger;
  /** Every card ever paid or owed, archived ones included — a master who left can still be owed. */
  names: Readonly<Record<string, string>>;
  /** The payouts made in the month, newest first, for the list under the table. */
  entries: readonly PayoutEntry[];
}>;

/**
 * «К выплате» for one month, read from the same places the month's report
 * reads: the visits' snapshots through `loadDashboard`, and the labour rules.
 *
 * The commission is the studio's own visits' — a renter's are out of the
 * studio-wide read, and a principal's never leaves the business, so neither is
 * owed to anybody. Costed visits only, the same set the P&L's labour line
 * sums, so that the cash flow can swap one for the other exactly.
 *
 * `whenTracked` skips the reading of visits for a month the balance does not
 * reach yet: the monthly report asks for every month, and most studios have
 * never marked a payout.
 */
export async function loadPayoutReport(
  tx: TenantTransaction,
  options: Readonly<{ month: string; currency: string; whenTracked?: boolean }>,
  locale: AppLocale,
): Promise<PayoutReport | null> {
  const payoutRows = await tx
    .select({
      id: masterPayouts.id,
      specialistId: masterPayouts.specialistId,
      amountMinor: masterPayouts.amountMinor,
      currency: masterPayouts.currency,
      paidOn: masterPayouts.paidOn,
      note: masterPayouts.note,
    })
    .from(masterPayouts)
    .orderBy(asc(masterPayouts.paidOn), asc(masterPayouts.createdAt));
  // One currency per report, as the ledger's totals are.
  const payouts = payoutRows.filter((row) => row.currency === options.currency);

  const startMonth = payoutStartMonth(payouts);
  const tracking = startMonth !== null && options.month >= startMonth;
  if (options.whenTracked && !tracking) return null;

  const months = tracking ? monthsBetween(startMonth, options.month) : [options.month];
  // The span's first instant and last, in UTC — `monthBounds` of `lib/period.ts`,
  // which imports this module and so cannot be imported back.
  const from = new Date(`${months[0]}-01T00:00:00.000Z`);
  const to = new Date(`${shiftMonth(options.month, 1)}-01T00:00:00.000Z`);
  to.setUTCMilliseconds(-1);
  const { rows } = await loadDashboard(tx, { from, to }, locale);

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

  const accruals: Record<string, MasterAccrual[]> = {};
  for (const month of months) {
    const own = rows.filter((row) => row.completedAt.toISOString().slice(0, 7) === month);
    const byMaster = new Map<string, { commissionMinor: number; wageMinor: number }>();
    const entry = (specialistId: string) => {
      const held = byMaster.get(specialistId) ?? { commissionMinor: 0, wageMinor: 0 };
      byMaster.set(specialistId, held);
      return held;
    };
    for (const row of own) {
      if (!row.specialistId || row.masterIsPrincipal === true || row.contributionMarginMinor === null) continue;
      entry(row.specialistId).commissionMinor += row.commissionMinor ?? 0;
    }
    // A share-of-revenue wage is a share of the same revenue the P&L reads.
    const revenueMinor = own.reduce((total, row) => total + row.revenueMinor, 0);
    for (const rule of selectLaborRules(laborRows, month)) {
      if (rule.recipient !== "specialist" || !rule.specialistId) continue;
      entry(rule.specialistId).wageMinor += monthlyWageMinor(rule, { revenueMinor });
    }
    accruals[month] = [...byMaster.entries()].map(([specialistId, amounts]) => ({ specialistId, ...amounts }));
  }

  const people = await tx.select({ id: specialists.id, name: specialists.name }).from(specialists);

  return {
    ledger: buildPayoutLedger({
      month: options.month,
      accruals,
      payouts: payouts.map((row) => ({ specialistId: row.specialistId, amountMinor: row.amountMinor, paidOn: row.paidOn })),
    }),
    names: Object.fromEntries(people.map((person) => [person.id, person.name])),
    entries: payouts
      .filter((row) => row.paidOn.slice(0, 7) === options.month)
      .reverse()
      .map((row) => ({
        id: row.id,
        specialistId: row.specialistId,
        amountMinor: row.amountMinor,
        paidOn: row.paidOn,
        note: row.note,
      })),
  };
}

/** Whether a specialist with this id is in the tenant's rows — RLS decides. */
export async function specialistExists(tx: TenantTransaction, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: specialists.id }).from(specialists).where(eq(specialists.id, id)).limit(1);
  return row !== undefined;
}
