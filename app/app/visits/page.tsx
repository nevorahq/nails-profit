import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import Link from "next/link";

import { ToolIcon } from "@/components/icons";
import { PeriodFilter } from "@/components/period-filter";
import { type AdjustMaterial, VisitAdjustForm } from "@/components/visit-adjust-form";
import { clients, consumptions, financialSnapshots, specialists, users, visitLines, visits } from "@/db/schema";
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
  const { membership, locale, currency } = await requireWorkspace();
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
      .select({ id: specialists.id, name: specialists.name, avatar: users.image })
      .from(specialists)
      .leftJoin(users, eq(specialists.userId, users.id))
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

    const incompleteIds = detailed
      .filter((d) => !d.snapshot || d.snapshot.contributionMarginMinor === null)
      .map((d) => d.visit.id);

    const consumptionRows =
      incompleteIds.length > 0
        ? await tx
            .select()
            .from(consumptions)
            .where(inArray(consumptions.visitId, incompleteIds))
        : [];

    const consumptionsByVisit = new Map<string, typeof consumptionRows>();
    for (const row of consumptionRows) {
      consumptionsByVisit.set(row.visitId, [...(consumptionsByVisit.get(row.visitId) ?? []), row]);
    }

    return { detailed, people, canFilterBySpecialist: ownSpecialistId === null, consumptionsByVisit };
  });

  const withMargin = data.detailed.filter(
    (row) => row.snapshot && row.snapshot.contributionMarginMinor !== null,
  ).length;

  const totalRevenue = data.detailed.reduce((sum, { snapshot }) => sum + (snapshot?.revenueMinor ?? 0), 0);
  const totalCommission = data.detailed.reduce((sum, { snapshot }) => sum + (snapshot?.commissionMinor ?? 0), 0);

  const canAddVisit = can(membership.role, "bookings", "write");

  // Grouped by master when the viewer can see more than their own (section
  // 6.1: a Master's list is already just their own, and a one-item group
  // labelled with their own name would say nothing a flat list didn't).
  type DetailedRow = (typeof data.detailed)[number];
  const groups: { key: string; title: string | null; avatar: string | null; rows: DetailedRow[] }[] = [];
  if (data.canFilterBySpecialist) {
    const bySpecialist = new Map<string, DetailedRow[]>();
    for (const row of data.detailed) {
      const id = row.visit.specialistId;
      bySpecialist.set(id, [...(bySpecialist.get(id) ?? []), row]);
    }
    for (const person of data.people) {
      const rows = bySpecialist.get(person.id);
      if (rows) {
        groups.push({ key: person.id, title: person.name, avatar: person.avatar, rows });
        bySpecialist.delete(person.id);
      }
    }
    // A visit whose specialist was archived since still needs somewhere to live.
    for (const [id, rows] of bySpecialist) {
      groups.push({ key: id, title: t("common.unnamed"), avatar: null, rows });
    }
  } else if (data.detailed.length > 0) {
    groups.push({ key: "own", title: null, avatar: null, rows: data.detailed });
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        {canAddVisit && (
          <Link className="header-action" href="/app/visits/new" aria-label={t("visits.close")}>
            <ToolIcon name="plus" />
          </Link>
        )}
      </header>

      <nav className="calendar-toolbar" aria-label={t("filters.title")}>
        <details className="calendar-filters visit-filters">
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

        {canAddVisit && (
          <Link className="primary-button calendar-create" href="/app/visits/new">
            <ToolIcon name="plus" />
            {t("visits.close")}
          </Link>
        )}
      </nav>

      {data.detailed.length > 0 && withMargin < data.detailed.length && (
        <div className="warning-banner">
          {t("visits.incompleteBanner", {
            incomplete: data.detailed.length - withMargin,
            total: data.detailed.length,
          })}
        </div>
      )}

      {groups.length === 0 && <p className="muted">{t("visits.none")}</p>}

      <div className="visit-groups">
        {groups.map((group) => (
          <section className={group.title ? "panel visit-group" : undefined} key={group.key}>
            {group.title && (
              <div className="visit-group-head">
                <span className="avatar" aria-hidden="true">
                  {group.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a studio's own photo, not a build-time asset.
                    <img src={group.avatar} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    group.title.trim().slice(0, 1).toUpperCase() || "?"
                  )}
                </span>
                <h2>{group.title}</h2>
              </div>
            )}
            <ul className="visit-cards">
              {group.rows.map(({ visit, snapshot, lines, clientName }) => {
                const serviceLine = lines.find((line) => line.kind === "service");
                const incomplete = !snapshot || snapshot.contributionMarginMinor === null;
                const visitConsumptions = data.consumptionsByVisit.get(visit.id) ?? [];
                const adjustMaterials: AdjustMaterial[] = visitConsumptions.map((c) => ({
                  materialId: c.materialId,
                  materialName: c.materialNameSnapshot,
                  baseUnit: c.baseUnitSnapshot,
                  normativeQuantityMilliUnits: c.normativeQuantityMilliUnits,
                  actualQuantityMilliUnits: c.actualQuantityMilliUnits,
                }));
                return (
                  <li key={visit.id} className={`visit-card${incomplete ? " is-incomplete" : ""}`}>
                    <div className="visit-card-head">
                      <span className="visit-card-date">
                        {visit.completedAt.toLocaleDateString(localeTag(locale))}
                      </span>
                      {visit.status === "adjusted" && (
                        <span className="badge-warning">{t("visits.adjusted")}</span>
                      )}
                    </div>
                    <p className="visit-card-service">
                      {serviceLine
                        ? (resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) ?? "—")
                        : "—"}
                      {lines.length > 1 && <span className="unit-hint">+{lines.length - 1}</span>}
                    </p>
                    <p className="visit-card-client">{clientName ?? <span className="muted">—</span>}</p>

                    {incomplete ? (
                      <>
                        <p className="visit-card-revenue">
                          <span>{t("visits.revenue")}</span>
                          <strong>{snapshot ? money(snapshot.revenueMinor) : "—"}</strong>
                        </p>
                        <div className="visit-card-warning">
                          <span className="badge-warning">
                            {(snapshot?.incompleteReasons ?? [])
                              .map((reason) => t(`reason.${reason}` as MessageKey))
                              .join("; ") || t("visits.noCalculation")}
                          </span>
                          <VisitAdjustForm
                            visitId={visit.id}
                            materials={adjustMaterials}
                            plannedDurationMinutes={visit.plannedDurationMinutes}
                            actualDurationMinutes={visit.actualDurationMinutes}
                            locale={locale}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="visit-card-metrics">
                        <div>
                          <span>{t("visits.revenue")}</span>
                          <strong>{money(snapshot!.revenueMinor)}</strong>
                        </div>
                        <div>
                          <span>{t("visits.keeps")}</span>
                          <strong
                            className={snapshot!.contributionMarginMinor! < 0 ? "metric-negative" : undefined}
                          >
                            {money(snapshot!.contributionMarginMinor!)}
                          </strong>
                        </div>
                        <div>
                          <span>{t("visits.margin")}</span>
                          <strong>{formatBasisPoints(snapshot!.marginBasisPoints, localeTag(locale))}</strong>
                        </div>
                        <div>
                          <span>{t("visits.hourly")}</span>
                          <strong className={snapshot!.profitPerHourMinor! < 0 ? "metric-negative" : undefined}>
                            {money(snapshot!.profitPerHourMinor!)}
                            {snapshot!.estimatedDuration && (
                              <span className="unit-hint">{t("visits.estimate")}</span>
                            )}
                          </strong>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {data.detailed.length > 0 && (
        <div className="visit-card-total">
          <span>
            {t("visits.total")}: <strong>{money(totalRevenue)}</strong>
          </span>
          <span>
            {t("visits.masterEarnings")}: <strong>{money(totalCommission)}</strong>
          </span>
        </div>
      )}
    </main>
  );
}
