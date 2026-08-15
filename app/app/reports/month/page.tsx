import Link from "next/link";

import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import type { ExpenseCategory } from "@/domain/expense-categories";
import { businessLabel } from "@/i18n/business-labels";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatHours, formatMoneyMinor } from "@/lib/format";
import { isMonth, loadPeriodPL, monthOf } from "@/lib/period";
import { requireWorkspace } from "@/lib/workspace";

/**
 * The month, line by line.
 *
 * This is the figure the product exists for and did not have: what the studio
 * kept after the work was paid for and the rent was paid. It is deliberately
 * not on the dashboard, which answers for any range of days — a recurring cost
 * belongs to a month, and half a month of rent is a number nobody agreed on.
 *
 * Owner-only, like the ledger it reads: rent and wages are in every line.
 */

/** `YYYY-MM` shifted by whole months, for the two arrows. */
function shiftMonth(month: string, by: number): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + by);
  return date.toISOString().slice(0, 7);
}

export default async function MonthReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { membership, locale, currency, businessType } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "expenses", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("pl.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
  // An unusable month is no month: the same rule the ledger's own date filter
  // follows, so a hand-edited query string cannot decide what is queried.
  const month = isMonth(filters.month) ? filters.month : monthOf(new Date());

  const report = await withTenant(membership.organizationId, (tx) =>
    loadPeriodPL(tx, { month, currency, organizationId: membership.organizationId }, locale),
  );
  const pl = report.pl;
  const capacity = report.capacity;
  const cash = report.cashFlow;

  const commissionRule = (rule: (typeof report.masterBreakdown)[number]["rules"][number]) => {
    const rate = rule.basisPoints === null ? null : formatBasisPoints(rule.basisPoints, localeCode);
    switch (rule.type) {
      case "percentage":
        return rate ?? "—";
      case "percentage_after_materials":
        return rate ? t("specialists.afterMaterials", { rate }) : "—";
      case "fixed":
        return rule.fixedAmountMinor === null ? "—" : money(rule.fixedAmountMinor);
      case "hybrid":
        return rule.fixedAmountMinor === null || !rate
          ? "—"
          : t("specialists.hybridRule", { amount: money(rule.fixedAmountMinor), rate });
      default:
        return "—";
    }
  };

  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);
  /** A cost, written as one. The minus is part of reading a P&L, not decoration. */
  const cost = (amount: number) => (amount === 0 ? money(0) : `− ${money(amount)}`);
  const monthLabel = new Intl.DateTimeFormat(localeCode, { month: "long", year: "numeric" }).format(
    new Date(`${month}-01T00:00:00.000Z`),
  );

  const hours = (minutes: number) => t("capacity.hours", { value: formatHours(minutes, localeCode) });
  const overheadLines = Object.entries(pl.overheadByCategory).sort(([, a], [, b]) => b - a);
  const cashOnlyLines = Object.entries(pl.cashOnlyByCategory).sort(([, a], [, b]) => b - a);
  const nothingHappened =
    pl.revenueMinor === 0 && pl.overheadMinor === 0 && pl.cashOnlyMinor === 0 && pl.incompleteVisits === 0;

  return (
    <main className="app-shell">
      <span className="eyebrow report-period">
        {t("pl.eyebrow")} · {monthLabel}
      </span>

      <nav className="month-nav" aria-label={t("pl.month")}>
        {/*
          The word goes on a phone and the accessible name stays: three rows of
          month controls pushed the report itself below the fold.
        */}
        <Link
          className="secondary-button"
          href={`/app/reports/month?month=${shiftMonth(month, -1)}`}
          aria-label={t("pl.previousMonth")}
        >
          ← <span className="month-nav-word">{t("pl.previousMonth")}</span>
        </Link>
        <form method="get">
          <label>
            <span className="sr-only">{t("pl.month")}</span>
            <input type="month" name="month" defaultValue={month} />
          </label>
          <button className="secondary-button" type="submit">
            {t("pl.show")}
          </button>
        </form>
        <Link
          className="secondary-button"
          href={`/app/reports/month?month=${shiftMonth(month, 1)}`}
          aria-label={t("pl.nextMonth")}
        >
          <span className="month-nav-word">{t("pl.nextMonth")}</span> →
        </Link>
      </nav>

      {report.excludedRows > 0 && (
        <p className="pl-note">{t("pl.otherCurrency", { count: report.excludedRows })}</p>
      )}

      {nothingHappened ? (
        <section className="empty-state">
          <span className="step-number">01</span>
          <h2>{t("pl.title")}</h2>
          <p>{t("pl.empty")}</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <h2>{t("pl.title")}</h2>
            <table className="data-table pl-table">
              <tbody>
                <tr>
                  <td>{t("pl.revenue")}</td>
                  <td>{money(pl.revenueMinor)}</td>
                </tr>
                {/*
                  Shown only when they happened. A studio that pays no VAT
                  should not read a row of zero and wonder whether it owes one.
                */}
                {pl.vatMinor > 0 && (
                  <tr>
                    <td className="pl-label">{t("pl.vat")}</td>
                    <td>{cost(pl.vatMinor)}</td>
                  </tr>
                )}
                {pl.turnoverTaxMinor > 0 && (
                  <tr>
                    <td className="pl-label">{t("pl.turnoverTax")}</td>
                    <td>{cost(pl.turnoverTaxMinor)}</td>
                  </tr>
                )}
                <tr>
                  <td className="pl-label">{t("pl.materials")}</td>
                  <td>{cost(pl.materialCostMinor)}</td>
                </tr>
                <tr className={pl.payrollTaxMinor > 0 || pl.paymentCommissionMinor > 0 ? undefined : "pl-subtotal"}>
                  <td className="pl-label">{t(businessLabel.labour[businessType])}</td>
                  <td>{cost(pl.labourCostMinor)}</td>
                </tr>
                {pl.payrollTaxMinor > 0 && (
                  <tr className={pl.paymentCommissionMinor > 0 ? undefined : "pl-subtotal"}>
                    <td className="pl-label">{t("pl.payrollTax")}</td>
                    <td>{cost(pl.payrollTaxMinor)}</td>
                  </tr>
                )}
                {pl.paymentCommissionMinor > 0 && (
                  <tr className="pl-subtotal">
                    <td className="pl-label">{t("pl.acquiring")}</td>
                    <td>{cost(pl.paymentCommissionMinor)}</td>
                  </tr>
                )}
                <tr>
                  <td>{t("pl.contributionMargin")}</td>
                  <td>{money(pl.contributionMarginMinor)}</td>
                </tr>
                {/*
                  Shown only when there is one to show. A studio whose owner does
                  not take visits should not be asked to read a line of zero and
                  wonder what it was for.
                */}
                {pl.principalLabourMinor > 0 && (
                  <tr className="pl-addback">
                    <td className="pl-label">{t(businessLabel.principalAddBack[businessType])}</td>
                    <td>+ {money(pl.principalLabourMinor)}</td>
                  </tr>
                )}
                {pl.salariedLabourMinor > 0 && (
                  <tr>
                    <td className="pl-label">{t("pl.salaried")}</td>
                    <td>{cost(pl.salariedLabourMinor)}</td>
                  </tr>
                )}
                <tr className="pl-subtotal">
                  <td className="pl-label">{t("pl.overhead")}</td>
                  <td>{cost(pl.overheadMinor)}</td>
                </tr>
                <tr className="pl-total">
                  <td>
                    {t("pl.operatingProfit")}{" "}
                    <span className="unit-hint">{t(businessLabel.operatingProfitHint[businessType])}</span>
                  </td>
                  <td className={pl.operatingProfitMinor < 0 ? "metric-negative" : undefined}>
                    {money(pl.operatingProfitMinor)}
                  </td>
                </tr>
                {pl.operatingMarginBasisPoints !== null && (
                  <tr className="pl-ratio">
                    <td colSpan={2}>
                      {t("pl.operatingMargin", {
                        rate: formatBasisPoints(pl.operatingMarginBasisPoints, localeCode),
                      })}
                    </td>
                  </tr>
                )}
                {/*
                  The second level, and only when the owner has said what their
                  work is worth. An unstated wage leaves the rows out rather
                  than printing a zero: zero is the claim that their time is
                  free, and it would read as profit nobody earned.
                */}
                {pl.ownerWageMinor !== null && pl.economicProfitMinor !== null && (
                  <>
                    <tr className="pl-subtotal">
                      <td className="pl-label">{t(businessLabel.ownerWage[businessType])}</td>
                      <td>{cost(pl.ownerWageMinor)}</td>
                    </tr>
                    <tr className="pl-total">
                      <td>{t("pl.economicProfit")}</td>
                      <td className={pl.economicProfitMinor < 0 ? "metric-negative" : undefined}>
                        {money(pl.economicProfitMinor)}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>

            {pl.economicProfitMinor !== null && <p className="pl-note">{t("pl.economicProfitHint")}</p>}

            {/*
              Not computed, and the reason plus the way out. The suggestion is
              what the owner already booked themselves at the market rate this
              month — the number they would otherwise have to work out by hand.
            */}
            {pl.ownerWageMinor === null && (
              <p className="pl-note">
                {pl.principalLabourMinor > 0
                  ? t("pl.ownerWageMissing", { suggested: money(pl.principalLabourMinor) })
                  : t("pl.ownerWageMissingIdle")}{" "}
                <Link className="text-link" href="/app/settings">
                  {t("pl.setOwnerWage")}
                </Link>
              </p>
            )}

            {pl.safeToWithdrawMinor !== null && report.withdrawalReserveMinor > 0 && (
              <p className="pl-note">
                <strong>
                  {t("pl.safeToWithdraw")}: {money(pl.safeToWithdrawMinor)}
                </strong>{" "}
                {t("pl.safeToWithdrawHint", { reserve: money(report.withdrawalReserveMinor) })}
              </p>
            )}

            {pl.principalLabourMinor > 0 && <p className="pl-note">{t(businessLabel.principalHint[businessType])}</p>}

            {pl.incompleteVisits > 0 && (
              <div className="warning-banner">
                {t("pl.marginFloor", {
                  count: pl.incompleteVisits,
                  revenue: money(pl.incompleteRevenueMinor),
                })}
                <ul>
                  {Object.entries(pl.incompleteReasonCounts).map(([reason, count]) => (
                    <li key={reason}>
                      {t(`reason.${reason}` as MessageKey)}: {count}
                    </li>
                  ))}
                </ul>
                <Link className="text-link" href="/app/visits">
                  {t("dashboard.openVisits")}
                </Link>
              </div>
            )}
          </section>

          {/*
            Where the money went, as opposed to where the profit went.
            Deliberately its own panel and its own bottom line: a profitable
            month with an empty account is the normal case, not an error, and
            one number for both is how an owner ends up unable to explain
            either.
          */}
          <section className="panel">
            <h2>{t("cash.title")}</h2>
            <table className="data-table pl-table">
              <tbody>
                <tr>
                  <td>{t("cash.received")}</td>
                  <td>{money(cash.revenueMinor)}</td>
                </tr>
                {cash.paymentCommissionMinor > 0 && (
                  <tr className="pl-subtotal">
                    <td className="pl-label">{t("pl.acquiring")}</td>
                    <td>{cost(cash.paymentCommissionMinor)}</td>
                  </tr>
                )}
                {cash.paymentCommissionMinor > 0 && (
                  <tr>
                    <td>{t("cash.settled")}</td>
                    <td>{money(cash.settledMinor)}</td>
                  </tr>
                )}
                <tr>
                  <td className="pl-label">{t("cash.visitLabour")}</td>
                  <td>{cost(cash.visitLabourMinor)}</td>
                </tr>
                {cash.salariedLabourMinor > 0 && (
                  <tr>
                    <td className="pl-label">{t("pl.salaried")}</td>
                    <td>{cost(cash.salariedLabourMinor)}</td>
                  </tr>
                )}
                <tr className={cash.ownerDrawsMinor > 0 ? undefined : "pl-subtotal"}>
                  <td className="pl-label">{t("cash.spent")}</td>
                  <td>{cost(cash.spentFromLedgerMinor)}</td>
                </tr>
                {cash.ownerDrawsMinor > 0 && (
                  <tr className="pl-subtotal">
                    <td className="pl-label">{t("cash.ownerDraws")}</td>
                    <td>{cost(cash.ownerDrawsMinor)}</td>
                  </tr>
                )}
                <tr className="pl-total">
                  <td>{t("cash.net")}</td>
                  <td className={cash.netCashMinor < 0 ? "metric-negative" : undefined}>
                    {money(cash.netCashMinor)}
                  </td>
                </tr>
                {/*
                  The line this statement exists for. Zero means the month's
                  profit and its cash agree, which is worth saying out loud
                  rather than leaving as an absent row.
                */}
                <tr className="pl-ratio">
                  <td colSpan={2}>
                    {cash.profitToCashGapMinor === 0
                      ? t("cash.gapNone")
                      : cash.profitToCashGapMinor > 0
                        ? t("cash.gapEarnedMore", { amount: money(cash.profitToCashGapMinor) })
                        : t("cash.gapBankedMore", { amount: money(-cash.profitToCashGapMinor) })}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="pl-note">{t("cash.hint")}</p>
            {cash.ledgerPayrollMinor > 0 && (
              <p className="pl-note">
                {t("cash.payrollExcluded", { amount: money(cash.ledgerPayrollMinor) })}
              </p>
            )}
          </section>

          {/*
            What the month had to sell, and what it had to sell to break even.
            Placed straight after the operating profit, because both figures
            are the same question asked forwards: that profit came from these
            hours, and this is the revenue at which it reaches zero.
          */}
          <section className="panel">
            <h2>{t("capacity.title")}</h2>

            {capacity.practicalMinutes > 0 ? (
              <>
                <table className="data-table pl-table">
                  <tbody>
                    <tr>
                      <td>{t("capacity.scheduled")}</td>
                      <td>{hours(capacity.scheduledMinutes)}</td>
                    </tr>
                    <tr className="pl-subtotal">
                      <td className="pl-label">
                        {t("capacity.practical", {
                          rate: formatBasisPoints(capacity.practicalCapacityBasisPoints, localeCode),
                        })}
                      </td>
                      <td>{hours(capacity.practicalMinutes)}</td>
                    </tr>
                    <tr>
                      <td>{t("capacity.booked")}</td>
                      <td>{hours(capacity.bookedMinutes)}</td>
                    </tr>
                    <tr className="pl-total">
                      <td>{t("capacity.utilization")}</td>
                      <td>{formatBasisPoints(capacity.utilizationBasisPoints, localeCode)}</td>
                    </tr>
                    {capacity.operatingProfitPerPracticalHourMinor !== null && (
                      <tr className="pl-ratio">
                        <td colSpan={2}>
                          {t("capacity.profitPerPracticalHour")}:{" "}
                          {t("capacity.perHour", {
                            amount: money(capacity.operatingProfitPerPracticalHourMinor),
                          })}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <p className="pl-note">{t("capacity.utilizationHint")}</p>
              </>
            ) : (
              /*
                No rota is not zero capacity — it is a question nobody answered.
                Saying «загрузка 0%» to a studio that simply has not filled in
                its hours would be a figure invented out of a missing one.
              */
              <p className="pl-note">
                {t("capacity.noRota")}{" "}
                <Link className="text-link" href="/app/booking">
                  {t("capacity.openSchedule")}
                </Link>
              </p>
            )}

            <table className="data-table pl-table">
              <tbody>
                <tr>
                  <td>{t("capacity.fixedCosts")}</td>
                  <td>{money(capacity.fixedCostMinor)}</td>
                </tr>
                {capacity.fixedCostRateMinorPerHour !== null && (
                  <tr className="pl-ratio">
                    <td colSpan={2}>
                      {t("capacity.ratePerHour")}:{" "}
                      {t("capacity.perHour", { amount: money(capacity.fixedCostRateMinorPerHour) })}
                    </td>
                  </tr>
                )}
                <tr className="pl-subtotal">
                  <td className="pl-label">{t("capacity.contributionRatio")}</td>
                  <td>{formatBasisPoints(capacity.contributionBasisPoints, localeCode)}</td>
                </tr>
                {capacity.breakEvenRevenueMinor !== null && (
                  <>
                    <tr className="pl-total">
                      <td>{t("capacity.breakEven")}</td>
                      <td>{money(capacity.breakEvenRevenueMinor)}</td>
                    </tr>
                    <tr className="pl-ratio">
                      <td colSpan={2}>
                        {capacity.revenueToBreakEvenMinor === 0
                          ? t("capacity.reached")
                          : t("capacity.toGo", { amount: money(capacity.revenueToBreakEvenMinor ?? 0) })}
                      </td>
                    </tr>
                    {capacity.breakEvenWithOwnerWageMinor !== null && (
                      <tr>
                        <td className="pl-label">
                          {t(businessLabel.breakEvenWithWage[businessType])}
                        </td>
                        <td>{money(capacity.breakEvenWithOwnerWageMinor)}</td>
                      </tr>
                    )}
                  </>
                )}
              </tbody>
            </table>

            {/*
              A missing break-even has two causes and only one of them is bad
              news. With revenue but no contribution, volume makes the loss
              worse and the owner has to be told. With no revenue at all there
              is simply nothing to compute a ratio from yet, and saying "every
              visit loses money" about a month with no visits would be a
              diagnosis of nothing.
            */}
            {capacity.breakEvenRevenueMinor === null ? (
              pl.revenueMinor > 0 && <div className="warning-banner">{t("capacity.noBreakEven")}</div>
            ) : (
              <p className="pl-note">{t("capacity.breakEvenHint")}</p>
            )}
            {capacity.fixedCostRateMinorPerHour !== null && (
              <p className="pl-note">{t("capacity.rateHint")}</p>
            )}
          </section>

          {report.masterBreakdown.length > 0 && (
            <section className="panel">
              <h2>{t("pl.masterBreakdown")}</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("specialists.specialist")}</th>
                    <th>{t("pl.visits")}</th>
                    <th>{t("pl.revenue")}</th>
                    <th>{t("pl.commissionRule")}</th>
                    <th>{t("pl.compensation")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.masterBreakdown.map((master) => (
                    <tr key={master.specialistId}>
                      <td>{master.name}</td>
                      <td>{master.visits}</td>
                      <td>{money(master.revenueMinor)}</td>
                      <td>{master.rules.map(commissionRule).join(" · ")}</td>
                      <td>{money(master.compensationMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {pl.materialCostMinor > 0 && (
            <section className="panel">
              <h2>{t("pl.materialBreakdown")}</h2>
              <table className="data-table pl-table">
                <tbody>
                  {report.materialBreakdown.map((line) => (
                    <tr key={line.category}>
                      <td>{t(`pl.materialCategory.${line.category}` as MessageKey)}</td>
                      <td>{money(line.costMinor)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{t("expenses.total")}</td>
                    <td>
                      <strong>{money(pl.materialCostMinor)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="pl-note">{t("pl.materialBreakdownHint")}</p>
            </section>
          )}

          {overheadLines.length > 0 && (
            <section className="panel">
              <h2>{t("pl.overheadTitle")}</h2>
              <table className="data-table pl-table">
                <tbody>
                  {overheadLines.map(([category, amount]) => (
                    <tr key={category}>
                      <td>{t(`expenses.category.${category as ExpenseCategory}`)}</td>
                      <td>{money(amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{t("expenses.total")}</td>
                    <td>
                      <strong>{money(pl.overheadMinor)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </section>
          )}

          {/*
            The half of the ledger that is deliberately not in the profit above.
            Printed rather than dropped: money did leave the account, and a
            report that showed neither the sum nor the reason would look like it
            had lost track of it.
          */}
          {cashOnlyLines.length > 0 && (
            <section className="panel">
              <h2>{t("pl.cashOnlyTitle")}</h2>
              <p className="pl-note">{t("pl.cashOnlyHint")}</p>
              <table className="data-table pl-table">
                <tbody>
                  {cashOnlyLines.map(([category, amount]) => (
                    <tr key={category}>
                      <td>{t(`expenses.category.${category as ExpenseCategory}`)}</td>
                      <td>{money(amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{t("expenses.total")}</td>
                    <td>
                      <strong>{money(pl.cashOnlyMinor)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </section>
          )}

          {/*
            Bought against used. The material catalogue has no editing screen at
            present, so this line is how a drifting price makes itself known
            instead of quietly inflating the margin — see section 8 of the plan.
          */}
          <section className="panel">
            <h2>{t("pl.reconciliationTitle")}</h2>
            <table className="data-table pl-table">
              <tbody>
                <tr>
                  <td>{t("pl.purchased")}</td>
                  <td>{money(pl.materialsPurchasedMinor)}</td>
                </tr>
                <tr className="pl-subtotal">
                  <td className="pl-label">{t("pl.consumed")}</td>
                  <td>{cost(pl.materialCostMinor)}</td>
                </tr>
                <tr>
                  <td>{t("pl.difference")}</td>
                  <td className={pl.materialsReconciliationMinor < 0 ? "metric-negative" : undefined}>
                    {money(pl.materialsReconciliationMinor)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="pl-note">{t("pl.reconciliationHint")}</p>
            {(pl.incompleteReasonCounts.missing_material_price ?? 0) > 0 && (
              <p className="pl-note">
                {t("pl.unpricedMaterials", { count: pl.incompleteReasonCounts.missing_material_price })}
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
