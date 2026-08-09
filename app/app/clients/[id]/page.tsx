import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { clients, financialSnapshots, specialists, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";
import { requireWorkspace } from "@/lib/workspace";

export default async function ClientCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: clientId } = await params;
  if (!z.uuid().safeParse(clientId).success) notFound();

  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);
  const tag = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, tag);

  if (!can(membership.role, "clients", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("clients.noAccess")}</p>
      </main>
    );
  }

  const data = await withTenant(membership.organizationId, async (tx) => {
    const [client] = await tx
      .select()
      .from(clients)
      .where(and(eq(clients.id, clientId), isNull(clients.anonymizedAt), isNull(clients.archivedAt)))
      .limit(1);

    if (!client) return null;

    // Master scope: resolve their specialist row.
    let ownSpecialistId: string | null = null;
    if (scopeFor(membership.role, "clients") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, membership.userId))
        .limit(1);
      ownSpecialistId = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    const visitRows = await tx
      .select({
        id: visits.id,
        completedAt: visits.completedAt,
        specialistId: visits.specialistId,
        plannedDurationMinutes: visits.plannedDurationMinutes,
        actualDurationMinutes: visits.actualDurationMinutes,
      })
      .from(visits)
      .where(
        ownSpecialistId
          ? and(eq(visits.clientId, clientId), eq(visits.specialistId, ownSpecialistId))
          : eq(visits.clientId, clientId),
      )
      .orderBy(desc(visits.completedAt));

    // For master scope, 404 if they haven't worked with this client.
    if (ownSpecialistId && visitRows.length === 0) return null;

    const visitIds = visitRows.map((v) => v.id);

    const [specialistRows, lineRows, snapshotRows] = await Promise.all([
      tx
        .select({ id: specialists.id, name: specialists.name })
        .from(specialists)
        .where(
          inArray(
            specialists.id,
            [...new Set(visitRows.map((v) => v.specialistId))],
          ),
        ),
      visitIds.length > 0
        ? tx.select().from(visitLines).where(inArray(visitLines.visitId, visitIds))
        : Promise.resolve([]),
      visitIds.length > 0
        ? tx
            .select()
            .from(financialSnapshots)
            .where(inArray(financialSnapshots.visitId, visitIds))
            .orderBy(desc(financialSnapshots.snapshotVersion))
        : Promise.resolve([]),
    ]);

    const specialistMap = new Map(specialistRows.map((s) => [s.id, s.name]));

    // Keep only the latest snapshot per visit.
    const latestSnapshot = new Map<string, (typeof snapshotRows)[0]>();
    for (const snap of snapshotRows) {
      if (!latestSnapshot.has(snap.visitId)) latestSnapshot.set(snap.visitId, snap);
    }

    // Group lines by visit.
    const linesByVisit = new Map<string, typeof lineRows>();
    for (const line of lineRows) {
      linesByVisit.set(line.visitId, [...(linesByVisit.get(line.visitId) ?? []), line]);
    }

    return { client, visitRows, specialistMap, latestSnapshot, linesByVisit };
  });

  if (!data) notFound();

  const { client, visitRows, specialistMap, latestSnapshot, linesByVisit } = data;

  const totalRevenue = visitRows.reduce(
    (sum, v) => sum + (latestSnapshot.get(v.id)?.revenueMinor ?? 0),
    0,
  );

  return (
    <main className="app-shell">
      <h1>{client.name}</h1>

      <div style={{ marginBottom: "8rem" }}>
        <Link href="/app/clients" className="muted" style={{ fontSize: "14rem" }}>
          ← {t("nav.clients")}
        </Link>
      </div>

      <section className="panel" style={{ marginBottom: "24rem" }}>
        <h2>{t("clients.contact")}</h2>
        <table className="data-table">
          <tbody>
            <tr>
              <td className="muted" style={{ width: "120rem" }}>{t("clients.name")}</td>
              <td>{client.name}</td>
            </tr>
            {client.normalizedPhone && (
              <tr>
                <td className="muted">{t("clients.phone")}</td>
                <td>{client.normalizedPhone}</td>
              </tr>
            )}
            {client.email && (
              <tr>
                <td className="muted">{t("clients.email")}</td>
                <td>{client.email}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>
          {t("clients.visitHistory")}
          {visitRows.length > 0 && (
            <span className="muted" style={{ fontWeight: 400, fontSize: "14rem", marginLeft: "8rem" }}>
              {visitRows.length} · {money(totalRevenue)}
            </span>
          )}
        </h2>

        {visitRows.length === 0 ? (
          <p className="muted">{t("visits.none")}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("visits.when")}</th>
                <th>{t("visits.service")}</th>
                <th>{t("clients.specialist")}</th>
                <th>{t("visits.revenue")}</th>
                <th>{t("common.duration")}</th>
              </tr>
            </thead>
            <tbody>
              {visitRows.map((visit) => {
                const lines = linesByVisit.get(visit.id) ?? [];
                const serviceLine = lines.find((l) => l.kind === "service");
                const snapshot = latestSnapshot.get(visit.id);
                const duration = visit.actualDurationMinutes ?? visit.plannedDurationMinutes;
                return (
                  <tr key={visit.id}>
                    <td>{visit.completedAt.toLocaleDateString(tag)}</td>
                    <td>
                      {serviceLine
                        ? (resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) ?? "—")
                        : "—"}
                      {lines.length > 1 && (
                        <span className="unit-hint">+{lines.length - 1}</span>
                      )}
                    </td>
                    <td className="muted">{specialistMap.get(visit.specialistId) ?? "—"}</td>
                    <td>{snapshot ? money(snapshot.revenueMinor) : <span className="muted">—</span>}</td>
                    <td className="muted">{duration} {t("common.minutes")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
