import { eq } from "drizzle-orm";

import { PeriodFilter } from "@/components/period-filter";
import { ProfitBars } from "@/components/profit-bars";
import { ReportTabs } from "@/components/report-tabs";
import { ServiceRankingTable } from "@/components/service-ranking";
import { specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor, seesIndividualPay } from "@/domain/rbac";
import { presetRanges, resolveReportPeriod, todayIn } from "@/domain/report-period";
import { getTranslator } from "@/i18n/t";
import { registerOf } from "@/i18n/lexicon";
import { localeTag } from "@/i18n/translate";
import { loadDashboard, loadSpecialistOptions } from "@/lib/dashboard";
import { isCalendarDay } from "@/lib/expenses";
import { formatMoneyMinor } from "@/lib/format";
import { requireWorkspace } from "@/lib/workspace";

/** Bars past this many fold into «Прочее», so the chart stays readable. */
const TOP_SERVICES_SHOWN = 4;

/**
 * «Услуги», the report's second tab: every service with every column.
 *
 * «Итог» answers how much is left and shows the ranking in four columns a
 * phone can hold; this is where revenue, the master's share and the margin
 * live, for the same period and the same master as the tab it was opened from.
 */
export default async function ServicesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; specialist?: string }>;
}) {
  const workspace = await requireWorkspace();
  const { membership, locale, currency, businessType, timezone } = workspace;
  const register = registerOf(workspace);
  const t = getTranslator(locale, register);

  if (!can(membership.role, "dashboard", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("dashboard.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
  const today = todayIn(new Date(), timezone);
  const period = resolveReportPeriod(
    {
      from: isCalendarDay(filters.from) ? filters.from : undefined,
      to: isCalendarDay(filters.to) ? filters.to : undefined,
    },
    today,
  );

  const isMaster = membership.role === "master";
  /*
   * Narrowing the report to one master is reading what that master is paid,
   * which an analyst's «агрегаты» do not cover — so a `specialist` the role
   * may not ask for is not asked, rather than merely not offered.
   */
  const canFilterBySpecialist =
    scopeFor(membership.role, "dashboard") === "all" && seesIndividualPay(membership.role);

  const { metrics, people } = await withTenant(membership.organizationId, async (tx) => {
    let specialistId = canFilterBySpecialist ? (filters.specialist ?? null) : null;
    if (scopeFor(membership.role, "dashboard") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, membership.userId))
        .limit(1);
      specialistId = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    const { metrics } = await loadDashboard(
      tx,
      {
        from: period.from ? new Date(`${period.from}T00:00:00.000Z`) : undefined,
        to: period.to ? new Date(`${period.to}T23:59:59.999Z`) : undefined,
        specialistId,
      },
      locale,
    );
    return { metrics, people: canFilterBySpecialist ? await loadSpecialistOptions(tx) : [] };
  });

  const money = (amount: number) => formatMoneyMinor(amount, currency, localeTag(locale));
  const top = metrics.ranking.slice(0, TOP_SERVICES_SHOWN);
  const rest = metrics.ranking.slice(TOP_SERVICES_SHOWN);
  const bars = [
    ...top.map((entry) => ({
      key: entry.serviceId ?? entry.serviceName,
      label: entry.serviceName,
      valueMinor: entry.contributionMarginMinor,
    })),
    ...(rest.length > 0
      ? [
          {
            key: "__other__",
            label: t("dashboard.otherServices"),
            valueMinor: rest.reduce((total, entry) => total + entry.contributionMarginMinor, 0),
          },
        ]
      : []),
  ];

  return (
    <main className="app-shell">
      <ReportTabs
        register={register}
        locale={locale}
        role={membership.role}
        active="services"
        state={{ from: filters.from, to: filters.to, specialist: filters.specialist, month: period.month }}
      />

      <PeriodFilter
        locale={locale}
        from={period.from}
        to={period.to}
        specialistId={canFilterBySpecialist ? filters.specialist : undefined}
        people={people}
        showSpecialist={canFilterBySpecialist && people.length > 1}
        presets={{ ranges: presetRanges(today), active: period.preset }}
      />

      {/* The studio's share per service — not a master's to read. */}
      {!isMaster && bars.length > 0 && (
        <section className="panel">
          <h2>{t("dashboard.profitByService")}</h2>
          <ProfitBars entries={bars} formatMoney={money} />
        </section>
      )}

      <ServiceRankingTable
        register={register}
        metrics={metrics}
        locale={locale}
        currency={currency}
        businessType={businessType}
        isMaster={isMaster}
      />
    </main>
  );
}
