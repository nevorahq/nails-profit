import { asc, eq, isNull, isNotNull, sql } from "drizzle-orm";

import { ClientManager, type ClientRow } from "@/components/client-manager";
import { ToolIcon } from "@/components/icons";
import { clients, specialists, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";
import { requireWorkspace } from "@/lib/workspace";

export default async function ClientsPage() {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "clients", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("clients.noAccess")}</p>
      </main>
    );
  }

  const canWrite = can(membership.role, "clients", "write");
  const hidePii = scopeFor(membership.role, "clients") === "all" && !canWrite;

  const rows: ClientRow[] = await withTenant(membership.organizationId, async (tx) => {
    // Section 6.1: Master sees only their own clients.
    let ownSpecialistId: string | null = null;
    if (scopeFor(membership.role, "clients") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, membership.userId))
        .limit(1);
      ownSpecialistId = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    // Load all active clients, scoped if needed.
    const clientRows = ownSpecialistId
      ? await tx
          .selectDistinct({
            id: clients.id,
            name: clients.name,
            normalizedPhone: clients.normalizedPhone,
            email: clients.email,
            anonymizedAt: clients.anonymizedAt,
          })
          .from(clients)
          .innerJoin(visits, eq(visits.clientId, clients.id))
          .where(
            sql`${clients.archivedAt} is null and ${visits.specialistId} = ${ownSpecialistId}`,
          )
          .orderBy(asc(clients.name))
      : await tx
          .select({
            id: clients.id,
            name: clients.name,
            normalizedPhone: clients.normalizedPhone,
            email: clients.email,
            anonymizedAt: clients.anonymizedAt,
          })
          .from(clients)
          .where(isNull(clients.archivedAt))
          .orderBy(asc(clients.name));

    if (clientRows.length === 0) return [];

    // Visit stats per client: count and last visit date.
    const statsRows = await tx
      .select({
        clientId: visits.clientId,
        visitCount: sql<number>`cast(count(*) as int)`,
        lastVisitAt: sql<Date | null>`max(${visits.completedAt})`,
      })
      .from(visits)
      .where(
        isNotNull(visits.clientId),
      )
      .groupBy(visits.clientId);

    const statsMap = new Map(statsRows.map((s) => [s.clientId, s]));

    // Revenue per client: sum the latest snapshot per visit.
    // DISTINCT ON picks the highest snapshot_version for each visit_id.
    const revenueRows = await tx.execute<{ client_id: string; total_revenue: string }>(
      sql`
        SELECT v.client_id, coalesce(sum(fs.revenue_minor), 0)::text AS total_revenue
        FROM visit v
        JOIN (
          SELECT DISTINCT ON (visit_id) visit_id, revenue_minor
          FROM financial_snapshot
          ORDER BY visit_id, snapshot_version DESC
        ) fs ON fs.visit_id = v.id
        WHERE v.client_id IS NOT NULL
        GROUP BY v.client_id
      `,
    );

    const revenueMap = new Map(revenueRows.map((r) => [r.client_id, parseInt(r.total_revenue, 10)]));

    const tag = localeTag(locale);
    const money = (amount: number) => formatMoneyMinor(amount, currency, tag);

    return clientRows.map((client) => {
      const stats = statsMap.get(client.id);
      const totalMinor = revenueMap.get(client.id) ?? 0;
      return {
        id: client.id,
        name: client.name,
        phone: hidePii ? null : (client.normalizedPhone ?? null),
        email: hidePii ? null : (client.email ?? null),
        anonymized: client.anonymizedAt !== null,
        visitCount: stats?.visitCount ?? 0,
        lastVisitAt: stats?.lastVisitAt ?? null,
        totalSpent: totalMinor > 0 ? money(totalMinor) : null,
      };
    });
  });

  // Sort by last visit descending. The aggregate query returns dates as strings.
  rows.sort((a, b) => {
    if (!a.lastVisitAt && !b.lastVisitAt) return a.name.localeCompare(b.name);
    if (!a.lastVisitAt) return 1;
    if (!b.lastVisitAt) return -1;
    return new Date(b.lastVisitAt).getTime() - new Date(a.lastVisitAt).getTime();
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        {/*
          The compose action. Two shapes of the one control, exactly as the
          calendar's own toolbar and round button are (`app/app/calendar/page.tsx`):
          a labelled toggle for a desktop, a round one for a phone. Both point
          at the add-client `<details>` `components/client-manager.tsx` renders
          further down the page; the click handling that opens (and, for
          either anchor, closes) it lives there, since this is a Server
          Component and cannot hold it.
        */}
        {canWrite && (
          <a className="primary-button calendar-create" href="#add-client">
            <ToolIcon name="plus" />
            {t("clients.addTitle")}
          </a>
        )}
        {canWrite && (
          <a
            className="header-action"
            href="#add-client"
            aria-label={t("clients.addTitle")}
            data-label-closed={t("clients.addTitle")}
            data-label-open={t("clients.hideAddTitle")}
          >
            <ToolIcon name="plus" />
            <ToolIcon name="minus" />
          </a>
        )}
      </header>
      <ClientManager
        clients={rows}
        canWrite={canWrite}
        currency={currency}
        locale={locale}
      />
    </main>
  );
}
