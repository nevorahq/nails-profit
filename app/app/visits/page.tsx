import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import Link from "next/link";

import { AppNav } from "@/components/app-nav";
import { PeriodFilter } from "@/components/period-filter";
import { clients, financialSnapshots, specialists, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";
import { requireWorkspace } from "@/lib/workspace";

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; specialist?: string }>;
}) {
  const { membership, organizationName, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeTag(locale));

  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("visits.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;

  const data = await withTenant(membership.organizationId, async (tx) => {
    // Section 6.1: a Master sees only their own visits, resolved from the
    // specialist row that carries their user id rather than from the query.
    let ownSpecialistId: string | null = null;
    if (scopeFor(membership.role, "bookings") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, membership.userId))
        .limit(1);
      ownSpecialistId = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    const conditions = [
      filters.from ? gte(visits.completedAt, new Date(filters.from)) : undefined,
      filters.to ? lte(visits.completedAt, new Date(`${filters.to}T23:59:59.999Z`)) : undefined,
      ownSpecialistId
        ? eq(visits.specialistId, ownSpecialistId)
        : filters.specialist
          ? eq(visits.specialistId, filters.specialist)
          : undefined,
    ].filter(Boolean);

    const rows = await tx
      .select()
      .from(visits)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(visits.completedAt));

    const people = await tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.name));

    const detailed = await Promise.all(
      rows.map(async (visit) => {
        const [snapshot] = await tx
          .select()
          .from(financialSnapshots)
          .where(eq(financialSnapshots.visitId, visit.id))
          .orderBy(desc(financialSnapshots.snapshotVersion))
          .limit(1);
        const lines = await tx.select().from(visitLines).where(eq(visitLines.visitId, visit.id));
        const [client] = visit.clientId
          ? await tx.select({ name: clients.name }).from(clients).where(eq(clients.id, visit.clientId))
          : [];
        return { visit, snapshot, lines, clientName: client?.name ?? null };
      }),
    );

    return { detailed, people, canFilterBySpecialist: ownSpecialistId === null };
  });

  const withMargin = data.detailed.filter(
    (row) => row.snapshot && row.snapshot.contributionMarginMinor !== null,
  ).length;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("visits.title")}</h1>
        </div>
        <AppNav active="/app/visits" locale={locale} />
      </header>

      <div className="button-row">
        <Link className="primary-button" href="/app/visits/new">
          {t("visits.close")}
        </Link>
      </div>

      <PeriodFilter
        locale={locale}
        from={filters.from}
        to={filters.to}
        specialistId={filters.specialist}
        people={data.people}
        showSpecialist={data.canFilterBySpecialist}
      />

      {data.detailed.length > 0 && withMargin < data.detailed.length && (
        <div className="warning-banner">
          {t("visits.incompleteBanner", {
            incomplete: data.detailed.length - withMargin,
            total: data.detailed.length,
          })}
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("visits.when")}</th>
            <th>{t("visits.service")}</th>
            <th>{t("visits.client")}</th>
            <th>{t("visits.revenue")}</th>
            <th>{t("visits.keeps")}</th>
            <th>{t("visits.margin")}</th>
            <th>{t("visits.hourly")}</th>
          </tr>
        </thead>
        <tbody>
          {data.detailed.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                {t("visits.none")}
              </td>
            </tr>
          )}
          {data.detailed.map(({ visit, snapshot, lines, clientName }) => {
            const serviceLine = lines.find((line) => line.kind === "service");
            const incomplete = !snapshot || snapshot.contributionMarginMinor === null;
            return (
              <tr key={visit.id}>
                <td>{visit.completedAt.toLocaleDateString(localeTag(locale))}</td>
                <td>
                  {serviceLine
                    ? (resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) ?? "—")
                    : "—"}
                  {lines.length > 1 && <span className="unit-hint">+{lines.length - 1}</span>}
                  {visit.status === "adjusted" && <span className="badge-warning">{t("visits.adjusted")}</span>}
                </td>
                <td>{clientName ?? <span className="muted">—</span>}</td>
                <td>{snapshot ? money(snapshot.revenueMinor) : "—"}</td>
                {incomplete ? (
                  <td colSpan={3}>
                    <span className="badge-warning">
                      {(snapshot?.incompleteReasons ?? [])
                        .map((reason) => t(`reason.${reason}` as MessageKey))
                        .join("; ") || t("visits.noCalculation")}
                    </span>
                  </td>
                ) : (
                  <>
                    <td className={snapshot!.contributionMarginMinor! < 0 ? "metric-negative" : ""}>
                      {money(snapshot!.contributionMarginMinor!)}
                    </td>
                    <td>{formatBasisPoints(snapshot!.marginBasisPoints, localeTag(locale))}</td>
                    <td className={snapshot!.profitPerHourMinor! < 0 ? "metric-negative" : ""}>
                      {money(snapshot!.profitPerHourMinor!)}
                      {snapshot!.estimatedDuration && <span className="unit-hint">{t("visits.estimate")}</span>}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
