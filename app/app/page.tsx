import { eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { memberships, organizations, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { auth } from "@/lib/auth";
import { WorkspaceSetup } from "@/components/workspace-setup";
import { costingReasonLabels, formatBasisPoints, formatMoneyMinor } from "@/lib/format";
import { loadDashboard, loadSpecialistOptions } from "@/lib/dashboard";
import type { AppLocale } from "@/i18n/messages";

const reasonLabels: Record<string, string> = {
  ...costingReasonLabels,
  missing_actual_consumption: "не записан фактический расход",
  missing_material_price: "у материала не было цены на момент визита",
  no_revenue: "визит без выручки",
};

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

  if (!can(membership.role, "dashboard", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">У вашей роли нет доступа к отчётам.</p>
      </main>
    );
  }

  const filters = await searchParams;
  const organizationId = membership.organization.id;
  const locale = membership.organization.locale as AppLocale;
  const currency = membership.organization.currency;

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
      ? `${filters.from ?? "начало"} — ${filters.to ?? "сегодня"}`
      : "за всё время";

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">Studio Ledger · {period}</span>
          <h1>{membership.organization.name}</h1>
        </div>
        <nav className="tab-nav">
          <Link className="active" href="/app">
            Отчёт
          </Link>
          <Link href="/app/visits">Визиты</Link>
          <Link href="/app/services">Услуги</Link>
          <Link href="/app/add-ons">Опции</Link>
          <Link href="/app/materials">Материалы</Link>
          <Link href="/app/specialists">Мастера</Link>
          <Link href="/app/import">Импорт</Link>
        </nav>
      </header>

      <form className="inline-form" method="get">
        <label>
          С
          <input type="date" name="from" defaultValue={filters.from ?? ""} />
        </label>
        <label>
          По
          <input type="date" name="to" defaultValue={filters.to ?? ""} />
        </label>
        {data.canFilterBySpecialist && (
          <label>
            Мастер
            <select name="specialist" defaultValue={filters.specialist ?? ""}>
              <option value="">все</option>
              {data.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="secondary-button" type="submit">
          Показать
        </button>
      </form>

      {metrics.visits === 0 ? (
        <section className="empty-state">
          <span className="step-number">01</span>
          <h2>Пока нет закрытых визитов</h2>
          <p>
            Отчёт строится из завершённых визитов. Закройте первый — и здесь появятся выручка, маржа и
            прибыль в час.
          </p>
          <div className="button-row">
            <Link className="primary-button" href="/app/visits/new">
              Закрыть визит
            </Link>
            {!data.hasSpecialists && (
              <Link className="secondary-button" href="/app/specialists">
                Сначала добавить мастера
              </Link>
            )}
          </div>
        </section>
      ) : (
        <>
          {metrics.incompleteVisits > 0 && (
            <div className="warning-banner">
              <strong>
                {metrics.incompleteVisits} из {metrics.visits} визитов не посчитаны
              </strong>{" "}
              — их выручка {formatMoneyMinor(metrics.incompleteRevenueMinor, currency)} учтена, но в марже
              они не участвуют, чтобы не занизить её.
              <ul>
                {Object.entries(metrics.incompleteReasonCounts).map(([reason, count]) => (
                  <li key={reason}>
                    {reasonLabels[reason] ?? reason}: {count}
                  </li>
                ))}
              </ul>
              <Link className="text-link" href="/app/visits">
                Открыть визиты →
              </Link>
            </div>
          )}

          <section className="panel insight-panel">
            <h2>Итоги периода</h2>
            <div className="metric-grid">
              <Metric
                label="Выручка"
                value={formatMoneyMinor(metrics.revenueMinor, currency)}
                formula={`сумма по ${metrics.visits} визитам`}
              />
              <Metric
                label="Останется вам"
                value={formatMoneyMinor(metrics.contributionMarginMinor, currency)}
                formula={`выручка − материалы − комиссия, по ${metrics.costedVisits} посчитанным`}
                strong
                negative={metrics.contributionMarginMinor < 0}
              />
              <Metric
                label="Маржа"
                value={formatBasisPoints(metrics.marginBasisPoints)}
                formula={`${formatMoneyMinor(metrics.contributionMarginMinor, currency)} ÷ ${formatMoneyMinor(metrics.costedRevenueMinor, currency)}`}
                negative={(metrics.marginBasisPoints ?? 0) < 0}
              />
              <Metric
                label="Прибыль в час"
                value={
                  metrics.profitPerHourMinor === null
                    ? "—"
                    : formatMoneyMinor(metrics.profitPerHourMinor, currency)
                }
                formula={`÷ ${Math.round(metrics.costedDurationMinutes / 60)} ч работы`}
                negative={(metrics.profitPerHourMinor ?? 0) < 0}
              />
            </div>
          </section>

          <section className="panel">
            <h2>Материалы: план и факт</h2>
            <div className="metric-grid">
              <Metric
                label="По рецептуре"
                value={formatMoneyMinor(metrics.normativeMaterialCostMinor, currency)}
                formula="норма расхода × закупочная цена"
              />
              <Metric
                label="Фактически"
                value={formatMoneyMinor(metrics.actualMaterialCostMinor, currency)}
                formula="фактический расход × цена на момент визита"
              />
              <Metric
                label="Отклонение"
                value={formatMoneyMinor(metrics.materialDeviationMinor, currency)}
                formula="факт − норма"
                negative={metrics.materialDeviationMinor > 0}
              />
            </div>
            {metrics.materialDeviationMinor > 0 && (
              <p className="muted">
                Расход выше нормы на {formatMoneyMinor(metrics.materialDeviationMinor, currency)} — стоит
                проверить нормы в рецептурах или списание.
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Услуги по прибыли</h2>
            <p className="muted">
              Порядок по сумме прибыли. Прибыль в час может расставить услуги иначе — длинная услуга
              приносит больше за визит, но меньше за час.
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Услуга</th>
                  <th>Визитов</th>
                  <th>Выручка</th>
                  <th>Останется</th>
                  <th>Маржа</th>
                  <th>В час</th>
                </tr>
              </thead>
              <tbody>
                {metrics.ranking.map((entry) => (
                  <tr key={entry.serviceId ?? entry.serviceName}>
                    <td>{entry.serviceName}</td>
                    <td>{entry.visits}</td>
                    <td>{formatMoneyMinor(entry.revenueMinor, currency)}</td>
                    <td className={entry.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                      {formatMoneyMinor(entry.contributionMarginMinor, currency)}
                    </td>
                    <td>{formatBasisPoints(entry.marginBasisPoints)}</td>
                    <td className={(entry.profitPerHourMinor ?? 0) < 0 ? "metric-negative" : ""}>
                      {entry.profitPerHourMinor === null
                        ? "—"
                        : formatMoneyMinor(entry.profitPerHourMinor, currency)}
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
