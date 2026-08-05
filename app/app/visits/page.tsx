import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import Link from "next/link";

import { clients, financialSnapshots, specialists, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { costingReasonLabels, formatBasisPoints, formatMoneyMinor } from "@/lib/format";
import { requireWorkspace } from "@/lib/workspace";

/** Reasons that only a visit can produce, on top of the catalogue ones. */
const visitReasonLabels: Record<string, string> = {
  ...costingReasonLabels,
  missing_actual_consumption: "не записан фактический расход",
  missing_material_price: "у материала не было цены на момент визита",
  no_revenue: "визит без выручки",
};

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; specialist?: string }>;
}) {
  const { membership, organizationName, locale, currency } = await requireWorkspace();

  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">У вашей роли нет доступа к визитам.</p>
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
          <h1>Визиты</h1>
        </div>
        <nav className="tab-nav">
          <Link href="/app">Отчёт</Link>
          <Link className="active" href="/app/visits">
            Визиты
          </Link>
          <Link href="/app/services">Услуги</Link>
          <Link href="/app/add-ons">Опции</Link>
          <Link href="/app/materials">Материалы</Link>
          <Link href="/app/specialists">Мастера</Link>
          <Link href="/app/import">Импорт</Link>
        </nav>
      </header>

      <div className="button-row">
        <Link className="primary-button" href="/app/visits/new">
          Закрыть визит
        </Link>
      </div>

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

      {data.detailed.length > 0 && withMargin < data.detailed.length && (
        <div className="warning-banner">
          У {data.detailed.length - withMargin} из {data.detailed.length} визитов маржа не посчитана —
          не хватает данных. Такие визиты помечены ниже.
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Когда</th>
            <th>Услуга</th>
            <th>Клиент</th>
            <th>Выручка</th>
            <th>Останется</th>
            <th>Маржа</th>
            <th>В час</th>
          </tr>
        </thead>
        <tbody>
          {data.detailed.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Визитов пока нет.
              </td>
            </tr>
          )}
          {data.detailed.map(({ visit, snapshot, lines, clientName }) => {
            const serviceLine = lines.find((line) => line.kind === "service");
            const incomplete = !snapshot || snapshot.contributionMarginMinor === null;
            return (
              <tr key={visit.id}>
                <td>{visit.completedAt.toLocaleDateString("ru-MD")}</td>
                <td>
                  {serviceLine
                    ? (resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) ?? "—")
                    : "—"}
                  {lines.length > 1 && <span className="unit-hint">+{lines.length - 1}</span>}
                  {visit.status === "adjusted" && <span className="badge-warning">скорректирован</span>}
                </td>
                <td>{clientName ?? <span className="muted">—</span>}</td>
                <td>{snapshot ? formatMoneyMinor(snapshot.revenueMinor, currency) : "—"}</td>
                {incomplete ? (
                  <td colSpan={3}>
                    <span className="badge-warning">
                      {(snapshot?.incompleteReasons ?? [])
                        .map((reason) => visitReasonLabels[reason] ?? reason)
                        .join("; ") || "нет расчёта"}
                    </span>
                  </td>
                ) : (
                  <>
                    <td className={snapshot!.contributionMarginMinor! < 0 ? "metric-negative" : ""}>
                      {formatMoneyMinor(snapshot!.contributionMarginMinor!, currency)}
                    </td>
                    <td>{formatBasisPoints(snapshot!.marginBasisPoints)}</td>
                    <td className={snapshot!.profitPerHourMinor! < 0 ? "metric-negative" : ""}>
                      {formatMoneyMinor(snapshot!.profitPerHourMinor!, currency)}
                      {snapshot!.estimatedDuration && <span className="unit-hint">оценка</span>}
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
