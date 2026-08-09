import { eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { MetricIcon, ToolIcon } from "@/components/icons";
import { OnboardingPanel } from "@/components/onboarding-panel";
import { PeriodFilter } from "@/components/period-filter";
import { ProfitBars } from "@/components/profit-bars";
import { ProfitTrendChart } from "@/components/profit-trend-chart";
import { WorkspaceSetup } from "@/components/workspace-setup";
import { db } from "@/db";
import { memberships, organizations, pilotEnrollments, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { buildProfitTrend } from "@/domain/dashboard-metrics";
import { starterMaterials } from "@/domain/import-templates";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { isPilotAccessEnforced } from "@/env";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { auth } from "@/lib/auth";
import { formatBasisPoints, formatMoneyMinor, formatPercentDelta } from "@/lib/format";
import { loadDashboard, loadSpecialistOptions } from "@/lib/dashboard";
import { resolveLocale } from "@/lib/locale";
import { loadOnboarding } from "@/lib/onboarding";

/** DSH-009: every figure states the formula it was computed with. */
function Metric({
  label,
  value,
  formula,
  strong,
  negative,
}: {
  label: string;
  value: string;
  formula: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`metric${strong ? " metric-strong" : ""}${negative ? " metric-negative" : ""}`}>
      <span title={formula}>{label}</span>
      <strong>{value}</strong>
      <small className="muted">{formula}</small>
    </div>
  );
}

/**
 * A period card for the reports page's top row. The formula still exists —
 * DSH-009 asks for one on every figure — but as a `title` tooltip rather than
 * visible text, since a period-over-period delta takes that line's place
 * whenever a comparable prior period exists (see `formatPercentDelta`).
 */
function MetricCard({
  icon,
  label,
  value,
  formula,
  delta,
  deltaCaption,
  negative,
}: {
  icon: "revenue" | "cost" | "profit" | "perHour";
  label: string;
  value: string;
  formula: string;
  delta: { text: string; direction: "up" | "down" } | null;
  deltaCaption: string;
  negative?: boolean;
}) {
  return (
    <div className="metric-card" title={formula}>
      <span className="metric-card-icon">
        <MetricIcon name={icon} />
      </span>
      <span className="metric-card-label">{label}</span>
      <strong className={`metric-card-value${negative ? " metric-negative" : ""}`}>{value}</strong>
      {delta && (
        <span className={`metric-delta ${delta.direction === "down" ? "negative" : "positive"}`}>
          {delta.text} {deltaCaption}
        </span>
      )}
    </div>
  );
}

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; specialist?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const [membership] = await db
    .select({
      organization: organizations,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, session.user.id))
    .limit(1);

  if (!membership) {
    // No organization yet, so its language does not exist to ask: the browser's
    // preference is the only signal, and it becomes the new workspace's locale.
    return <WorkspaceSetup name={session.user.name} locale={await resolveLocale()} />;
  }

  const locale = membership.organization.locale as AppLocale;
  const t = getTranslator(locale);

  const pilotStatus =
    isPilotAccessEnforced()
      ? await withTenant(membership.organization.id, async (tx) => {
          const [enrollment] = await tx
            .select({ status: pilotEnrollments.status })
            .from(pilotEnrollments)
            .limit(1);
          return enrollment?.status ?? null;
        })
      : null;

  if (isPilotAccessEnforced() && pilotStatus !== "active") {
    return (
      <main className="auth-shell">
        <section className="auth-card workspace-card" aria-labelledby="pilot-access-title">
          <span className="brand">Nail Profit OS</span>
          <h1 id="pilot-access-title">{t("pilot.accessTitle")}</h1>
          <p>{t("pilot.accessBody")}</p>
        </section>
      </main>
    );
  }

  if (!can(membership.role, "dashboard", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("dashboard.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
  const organizationId = membership.organization.id;
  const currency = membership.organization.currency;
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);

  // The period cards compare against the equal-length window immediately
  // before the selected one — only defined when a specific period was picked;
  // "all time" has no prior period to be a delta against.
  const previousRange =
    filters.from && filters.to
      ? (() => {
          const currentFrom = new Date(`${filters.from}T00:00:00.000Z`);
          const currentTo = new Date(`${filters.to}T23:59:59.999Z`);
          const spanMs = currentTo.getTime() - currentFrom.getTime() + 1;
          const previousTo = new Date(currentFrom.getTime() - 1);
          const previousFrom = new Date(previousTo.getTime() - spanMs + 1);
          return { from: previousFrom, to: previousTo };
        })()
      : null;

  const data = await withTenant(organizationId, async (tx) => {
    // Section 6.1: a Master sees "только собственные" — resolved from the
    // specialist row carrying their user id, not from the query string.
    let effectiveSpecialist = filters.specialist ?? null;
    if (scopeFor(membership.role, "dashboard") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, session.user.id))
        .limit(1);
      effectiveSpecialist = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    const dashboard = await loadDashboard(
      tx,
      {
        from: filters.from ? new Date(filters.from) : undefined,
        to: filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : undefined,
        specialistId: effectiveSpecialist,
      },
      locale,
    );

    const previousMetrics = previousRange
      ? (
          await loadDashboard(
            tx,
            { from: previousRange.from, to: previousRange.to, specialistId: effectiveSpecialist },
            locale,
          )
        ).metrics
      : null;

    const people = await loadSpecialistOptions(tx);
    const onboarding = await loadOnboarding(tx);
    const activeSpecialists = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(isNull(specialists.archivedAt));

    return {
      ...dashboard,
      previousMetrics,
      onboarding,
      people,
      canFilterBySpecialist: scopeFor(membership.role, "dashboard") === "all",
      hasSpecialists: activeSpecialists.length > 0,
    };
  });

  const isMaster = membership.role === "master";
  const { metrics, previousMetrics } = data;

  // «Себестоимость» is the complement of profit within revenue rather than a
  // separate ledger figure — materials and commission for uncosted visits are
  // not yet known, and this stays true to what the cards above it show.
  const costMinor = metrics.revenueMinor - metrics.contributionMarginMinor;
  const previousCostMinor = previousMetrics ? previousMetrics.revenueMinor - previousMetrics.contributionMarginMinor : null;
  const revenueDelta = previousMetrics
    ? formatPercentDelta(metrics.revenueMinor, previousMetrics.revenueMinor, localeCode)
    : null;
  const costDelta =
    previousCostMinor !== null ? formatPercentDelta(costMinor, previousCostMinor, localeCode) : null;
  const profitDelta = previousMetrics
    ? formatPercentDelta(metrics.contributionMarginMinor, previousMetrics.contributionMarginMinor, localeCode)
    : null;
  const perHourDelta =
    previousMetrics && metrics.profitPerHourMinor !== null && previousMetrics.profitPerHourMinor !== null
      ? formatPercentDelta(metrics.profitPerHourMinor, previousMetrics.profitPerHourMinor, localeCode)
      : null;

  // «Прибыль по услугам»: the top of the same ranking the full table below
  // shows, with everything past it folded into one «Прочее» bar so five bars
  // stay readable regardless of how many services the catalogue has.
  const TOP_SERVICES_SHOWN = 4;
  const topServices = metrics.ranking.slice(0, TOP_SERVICES_SHOWN);
  const otherServices = metrics.ranking.slice(TOP_SERVICES_SHOWN);
  const profitByServiceEntries = [
    ...topServices.map((entry) => ({
      key: entry.serviceId ?? entry.serviceName,
      label: entry.serviceName,
      valueMinor: entry.contributionMarginMinor,
    })),
    ...(otherServices.length > 0
      ? [
          {
            key: "__other__",
            label: t("dashboard.otherServices"),
            valueMinor: otherServices.reduce((total, entry) => total + entry.contributionMarginMinor, 0),
          },
        ]
      : []),
  ];

  // «Диаграмма прибыли»: bucketed by `buildProfitTrend` (day or month, decided
  // from the actual spread of the data), labelled here since that is where
  // the viewer's locale lives.
  const profitTrend = buildProfitTrend(data.rows);
  const trendLabelFormat = new Intl.DateTimeFormat(
    localeCode,
    profitTrend.granularity === "day" ? { day: "numeric", month: "short" } : { month: "short", year: "numeric" },
  );
  const profitTrendPoints = profitTrend.points.map((point) => ({
    label: trendLabelFormat.format(
      new Date(profitTrend.granularity === "day" ? `${point.key}T00:00:00Z` : `${point.key}-01T00:00:00Z`),
    ),
    valueMinor: point.profitMinor,
  }));

  const rankingTotals = {
    visits: metrics.ranking.reduce((s, e) => s + e.visits, 0),
    revenueMinor: metrics.ranking.reduce((s, e) => s + e.revenueMinor, 0),
    contributionMarginMinor: metrics.ranking.reduce((s, e) => s + e.contributionMarginMinor, 0),
    commissionMinor: metrics.ranking.reduce((s, e) => s + e.commissionMinor, 0),
  };
  const period =
    filters.from || filters.to
      ? `${filters.from ?? t("filters.periodStart")} — ${filters.to ?? t("filters.periodToday")}`
      : t("filters.allTime");

  return (
    <main className="app-shell">
      <span className="eyebrow report-period">
        {t("dashboard.eyebrow")} · {period}
      </span>

      <details className="calendar-filters report-filters">
        <summary>
          <ToolIcon name="filter" />
          {t("filters.title")}
        </summary>
        <PeriodFilter
          locale={locale}
          from={filters.from}
          to={filters.to}
          specialistId={filters.specialist}
          people={data.people}
          showSpecialist={data.canFilterBySpecialist}
        />
      </details>

      {!data.onboarding.complete && (
        <OnboardingPanel
          progress={data.onboarding}
          starterCount={starterMaterials.length}
          canSeedMaterials={canManageCatalogue(membership.role, "materials")}
          locale={locale}
        />
      )}

      {metrics.visits === 0 ? (
        <section className="empty-state">
          <span className="step-number">01</span>
          <h2>{t("dashboard.emptyTitle")}</h2>
          <p>{t("dashboard.emptyBody")}</p>
          <div className="button-row">
            <Link className="primary-button" href="/app/visits/new">
              {t("dashboard.closeVisit")}
            </Link>
            {!data.hasSpecialists && (
              <Link className="secondary-button" href="/app/specialists">
                {t("dashboard.addSpecialistFirst")}
              </Link>
            )}
          </div>
        </section>
      ) : (
        <>
          {metrics.incompleteVisits > 0 && (
            <div className="warning-banner">
              <strong>
                {t("dashboard.incompleteTitle", {
                  incomplete: metrics.incompleteVisits,
                  total: metrics.visits,
                })}
              </strong>{" "}
              {t("dashboard.incompleteBody", { revenue: money(metrics.incompleteRevenueMinor) })}
              <ul>
                {Object.entries(metrics.incompleteReasonCounts).map(([reason, count]) => (
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

          {!isMaster && (
            <section className="panel insight-panel">
              <h2>{t("dashboard.periodTotals")}</h2>
              <div className="metric-cards">
                <MetricCard
                  icon="revenue"
                  label={t("dashboard.revenue")}
                  value={money(metrics.revenueMinor)}
                  formula={t("dashboard.revenueFormula", { visits: metrics.visits })}
                  delta={revenueDelta}
                  deltaCaption={t("dashboard.vsPreviousPeriod")}
                />
                <MetricCard
                  icon="cost"
                  label={t("dashboard.cost")}
                  value={money(costMinor)}
                  formula={t("dashboard.costFormula")}
                  delta={costDelta}
                  deltaCaption={t("dashboard.vsPreviousPeriod")}
                />
                <MetricCard
                  icon="profit"
                  label={t("dashboard.profit")}
                  value={money(metrics.contributionMarginMinor)}
                  formula={t("dashboard.marginFormula", { visits: metrics.costedVisits })}
                  delta={profitDelta}
                  deltaCaption={t("dashboard.vsPreviousPeriod")}
                  negative={metrics.contributionMarginMinor < 0}
                />
                <MetricCard
                  icon="perHour"
                  label={t("dashboard.perHour")}
                  value={metrics.profitPerHourMinor === null ? "—" : money(metrics.profitPerHourMinor)}
                  formula={t("dashboard.perHourFormula", {
                    hours: Math.round(metrics.costedDurationMinutes / 60),
                  })}
                  delta={perHourDelta}
                  deltaCaption={t("dashboard.vsPreviousPeriod")}
                  negative={(metrics.profitPerHourMinor ?? 0) < 0}
                />
              </div>
            </section>
          )}

          {!isMaster && profitByServiceEntries.length > 0 && (
            <div className="report-charts-grid">
              <section className="panel">
                <h2>{t("dashboard.profitByService")}</h2>
                <ProfitBars entries={profitByServiceEntries} formatMoney={money} />
              </section>
              <section className="panel">
                <h2>{t("dashboard.profitTrend")}</h2>
                <ProfitTrendChart
                  points={profitTrendPoints}
                  formatMoney={money}
                  emptyLabel={t("dashboard.profitTrendEmpty")}
                  title={t("dashboard.profitTrend")}
                />
              </section>
            </div>
          )}

          {!isMaster && <section className="panel">
            <h2>{t("dashboard.materialsTitle")}</h2>
            <div className="metric-grid">
              <Metric
                label={t("dashboard.normative")}
                value={money(metrics.normativeMaterialCostMinor)}
                formula={t("dashboard.normativeFormula")}
              />
              <Metric
                label={t("dashboard.actual")}
                value={money(metrics.actualMaterialCostMinor)}
                formula={t("dashboard.actualFormula")}
              />
              <Metric
                label={t("dashboard.deviation")}
                value={money(metrics.materialDeviationMinor)}
                formula={t("dashboard.deviationFormula")}
                negative={metrics.materialDeviationMinor > 0}
              />
            </div>
            {metrics.materialDeviationMinor > 0 && (
              <p className="muted">
                {t("dashboard.overspend", { amount: money(metrics.materialDeviationMinor) })}
              </p>
            )}
          </section>}

          <section className="panel">
            <h2>{t("dashboard.rankingTitle")}</h2>
            <p className="muted">{t("dashboard.rankingHint")}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("dashboard.service")}</th>
                  <th>{t("dashboard.visitCount")}</th>
                  {!isMaster && <th>{t("dashboard.revenue")}</th>}
                  {!isMaster && <th>{t("dashboard.masterEarnings")}</th>}
                  <th>{isMaster ? t("dashboard.commission") : t("dashboard.keeps")}</th>
                  {!isMaster && <th>{t("dashboard.margin")}</th>}
                  <th>{t("dashboard.hourly")}</th>
                </tr>
              </thead>
              <tbody>
                {metrics.ranking.map((entry) => (
                  <tr key={entry.serviceId ?? entry.serviceName}>
                    <td>{entry.serviceName}</td>
                    <td>{entry.visits}</td>
                    {!isMaster && <td>{money(entry.revenueMinor)}</td>}
                    {!isMaster && <td>{money(entry.commissionMinor)}</td>}
                    {isMaster ? (
                      <td>{money(entry.commissionMinor)}</td>
                    ) : (
                      <td className={entry.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                        {money(entry.contributionMarginMinor)}
                      </td>
                    )}
                    {!isMaster && <td>{formatBasisPoints(entry.marginBasisPoints, localeTag(locale))}</td>}
                    <td className={(entry.profitPerHourMinor ?? 0) < 0 ? "metric-negative" : ""}>
                      {entry.profitPerHourMinor === null ? "—" : money(entry.profitPerHourMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{t("visits.total")}</th>
                  <td>{rankingTotals.visits}</td>
                  {!isMaster && <td>{money(rankingTotals.revenueMinor)}</td>}
                  {!isMaster && <td>{money(rankingTotals.commissionMinor)}</td>}
                  {isMaster ? (
                    <td>{money(rankingTotals.commissionMinor)}</td>
                  ) : (
                    <td className={rankingTotals.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                      {money(rankingTotals.contributionMarginMinor)}
                    </td>
                  )}
                  {!isMaster && <td />}
                  <td />
                </tr>
              </tfoot>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
