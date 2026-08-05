import { eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppNav } from "@/components/app-nav";
import { PeriodFilter } from "@/components/period-filter";
import { WorkspaceSetup } from "@/components/workspace-setup";
import { db } from "@/db";
import { memberships, organizations, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { auth } from "@/lib/auth";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";
import { loadDashboard, loadSpecialistOptions } from "@/lib/dashboard";

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

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; specialist?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const [membership] = await db
    .select({ organization: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, session.user.id))
    .limit(1);

  if (!membership) {
    return <WorkspaceSetup name={session.user.name} />;
  }

  const locale = membership.organization.locale as AppLocale;
  const t = getTranslator(locale);

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
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeTag(locale));

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

    const people = await loadSpecialistOptions(tx);
    const activeSpecialists = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(isNull(specialists.archivedAt));

    return {
      ...dashboard,
      people,
      canFilterBySpecialist: scopeFor(membership.role, "dashboard") === "all",
      hasSpecialists: activeSpecialists.length > 0,
    };
  });

  const { metrics } = data;
  const period =
    filters.from || filters.to
      ? `${filters.from ?? t("filters.periodStart")} — ${filters.to ?? t("filters.periodToday")}`
      : t("filters.allTime");

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">
            {t("dashboard.eyebrow")} · {period}
          </span>
          <h1>{membership.organization.name}</h1>
        </div>
        <AppNav active="/app" locale={locale} />
      </header>

      <PeriodFilter
        locale={locale}
        from={filters.from}
        to={filters.to}
        specialistId={filters.specialist}
        people={data.people}
        showSpecialist={data.canFilterBySpecialist}
      />

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

          <section className="panel insight-panel">
            <h2>{t("dashboard.periodTotals")}</h2>
            <div className="metric-grid">
              <Metric
                label={t("dashboard.revenue")}
                value={money(metrics.revenueMinor)}
                formula={t("dashboard.revenueFormula", { visits: metrics.visits })}
              />
              <Metric
                label={t("dashboard.youKeep")}
                value={money(metrics.contributionMarginMinor)}
                formula={t("dashboard.marginFormula", { visits: metrics.costedVisits })}
                strong
                negative={metrics.contributionMarginMinor < 0}
              />
              <Metric
                label={t("dashboard.margin")}
                value={formatBasisPoints(metrics.marginBasisPoints, localeTag(locale))}
                formula={`${money(metrics.contributionMarginMinor)} ÷ ${money(metrics.costedRevenueMinor)}`}
                negative={(metrics.marginBasisPoints ?? 0) < 0}
              />
              <Metric
                label={t("dashboard.perHour")}
                value={metrics.profitPerHourMinor === null ? "—" : money(metrics.profitPerHourMinor)}
                formula={t("dashboard.perHourFormula", {
                  hours: Math.round(metrics.costedDurationMinutes / 60),
                })}
                negative={(metrics.profitPerHourMinor ?? 0) < 0}
              />
            </div>
          </section>

          <section className="panel">
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
          </section>

          <section className="panel">
            <h2>{t("dashboard.rankingTitle")}</h2>
            <p className="muted">{t("dashboard.rankingHint")}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("dashboard.service")}</th>
                  <th>{t("dashboard.visitCount")}</th>
                  <th>{t("dashboard.revenue")}</th>
                  <th>{t("dashboard.keeps")}</th>
                  <th>{t("dashboard.margin")}</th>
                  <th>{t("dashboard.hourly")}</th>
                </tr>
              </thead>
              <tbody>
                {metrics.ranking.map((entry) => (
                  <tr key={entry.serviceId ?? entry.serviceName}>
                    <td>{entry.serviceName}</td>
                    <td>{entry.visits}</td>
                    <td>{money(entry.revenueMinor)}</td>
                    <td className={entry.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                      {money(entry.contributionMarginMinor)}
                    </td>
                    <td>{formatBasisPoints(entry.marginBasisPoints, localeTag(locale))}</td>
                    <td className={(entry.profitPerHourMinor ?? 0) < 0 ? "metric-negative" : ""}>
                      {entry.profitPerHourMinor === null ? "—" : money(entry.profitPerHourMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
