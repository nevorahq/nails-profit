import { PayoutLedger } from "@/components/payout-ledger";
import { MonthPicker } from "@/components/month-picker";
import { ReportTabs } from "@/components/report-tabs";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { currentMonthIn, monthRange, todayIn } from "@/domain/report-period";
import { formatLocalDate } from "@/domain/timezone";
import { registerOf } from "@/i18n/lexicon";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";
import { loadPayoutReport } from "@/lib/payouts";
import { isMonth } from "@/lib/period";
import { requireWorkspace } from "@/lib/workspace";

/**
 * «К выплате»: what the studio owes each master, and the press that records
 * handing it over.
 *
 * Owner-only, like the month report beside it: it is everybody's pay, line by
 * line. The page asks the matrix itself — the tab is hidden from everyone
 * else, and a hidden tab is not a refusal.
 */
export default async function PayoutsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const workspace = await requireWorkspace();
  const { membership, locale, currency, businessType, timezone } = workspace;
  const register = registerOf(workspace);
  const t = getTranslator(locale, register);

  if (!can(membership.role, "expenses", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("payouts.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
  const thisMonth = currentMonthIn(new Date(), timezone);
  const month = isMonth(filters.month) ? filters.month : thisMonth;
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);
  const monthName = (value: string) =>
    new Intl.DateTimeFormat(localeCode, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${value}-01T00:00:00Z`),
    );

  const report = await withTenant(membership.organizationId, (tx) =>
    loadPayoutReport(tx, { month, currency }, locale),
  );
  const { ledger, names, entries } = report!;
  const nameOf = (id: string) => names[id] ?? "—";

  return (
    <main className="app-shell">
      <ReportTabs
        register={register}
        locale={locale}
        role={membership.role}
        businessType={businessType}
        active="payouts"
        state={month === thisMonth ? { month } : { ...monthRange(month), month }}
      />
      <span className="eyebrow report-period">
        {t("payouts.eyebrow")} · {monthName(month)}
      </span>

      <MonthPicker
        locale={locale}
        localeTag={localeCode}
        month={month}
        thisMonth={thisMonth}
        path="/app/reports/payouts"
      />

      {ledger.tracking ? (
        <p className="pl-note">
          {t("payouts.trackingSince", { month: monthName(ledger.startMonth!) })}{" "}
          {ledger.totals.closingMinor !== 0 && t("payouts.totalOwed", { amount: money(ledger.totals.closingMinor) })}
        </p>
      ) : (
        <p className="pl-note">{t("payouts.notTracking")}</p>
      )}
      <p className="muted">{t("payouts.hint")}</p>

      <PayoutLedger
        rows={ledger.rows.map((row) => ({ ...row, name: nameOf(row.specialistId) }))}
        entries={entries.map((entry) => ({ ...entry, name: nameOf(entry.specialistId) }))}
        tracking={ledger.tracking}
        currency={currency}
        locale={locale}
        localeTag={localeCode}
        today={formatLocalDate(todayIn(new Date(), timezone))}
      />
    </main>
  );
}
