import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import {
  clients,
  financialSnapshots,
  specialistAvatars,
  specialists,
  visitLines,
  visitPhotos,
  visits,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { scopeFor, type MemberRole } from "@/domain/rbac";

export type VisitListFilters = Readonly<{
  from?: string;
  to?: string;
  specialist?: string;
  /** One visit, opened: where the calendar sends a visit closed without an appointment. */
  onlyVisit: string | null;
}>;

/**
 * What the visits page draws, read in a fixed number of statements.
 *
 * The page used to read each visit's newest snapshot, its lines and its
 * client's name with a query apiece, inside `Promise.all` — which looks
 * concurrent and is not: every statement of one transaction goes down the same
 * connection, one after the other, and each carries a parameter, which costs
 * two round trips to a database in another region. Sixty visits were two
 * hundred statements and half a minute. They are read together now, by the
 * visit ids, as `lib/dashboard.ts` already does for the figures.
 */
export async function loadVisitList(
  tx: TenantTransaction,
  caller: Readonly<{ userId: string; role: MemberRole }>,
  filters: VisitListFilters,
  showsPhotos: boolean,
) {
  // Section 6.1: a Master sees only their own visits, resolved from the
  // specialist row that carries their user id rather than from the query.
  let ownSpecialistId: string | null = null;
  if (scopeFor(caller.role, "bookings") === "own") {
    const [own] = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(eq(specialists.userId, caller.userId))
      .limit(1);
    ownSpecialistId = own?.id ?? "00000000-0000-0000-0000-000000000000";
  }

  const conditions = [
    filters.onlyVisit ? eq(visits.id, filters.onlyVisit) : undefined,
    filters.from ? gte(visits.completedAt, new Date(filters.from)) : undefined,
    filters.to ? lte(visits.completedAt, new Date(`${filters.to}T23:59:59.999Z`)) : undefined,
    ownSpecialistId
      ? eq(visits.specialistId, ownSpecialistId)
      : filters.specialist
        ? eq(visits.specialistId, filters.specialist)
        : undefined,
  ].filter(Boolean);

  // The client's name comes with the visit: a left join, because a visit may
  // have none, and it is the same tenant on both sides.
  const visitRows = await tx
    .select({ visit: visits, clientName: clients.name })
    .from(visits)
    .leftJoin(clients, eq(visits.clientId, clients.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(visits.completedAt));
  const rows = visitRows.map((row) => row.visit);
  const visitIds = rows.map((visit) => visit.id);

  /*
   * The photo comes from the card, which is where a studio sets it.
   *
   * It used to come from `user.image` through the linked account — a column
   * nothing has ever written, so this list has drawn letters since it was
   * built, and would have gone on drawing them for the masters who have no
   * account to hang a picture off at all.
   */
  const people = await tx
    .select({
      id: specialists.id,
      name: specialists.name,
      avatarVersion: specialistAvatars.version,
    })
    .from(specialists)
    .leftJoin(specialistAvatars, eq(specialists.id, specialistAvatars.specialistId))
    .where(isNull(specialists.archivedAt))
    .orderBy(asc(specialists.name));

  const [snapshots, lines] =
    visitIds.length === 0
      ? [[], []]
      : [
          /*
           * `DISTINCT ON (visit_id) ... ORDER BY visit_id, snapshot_version
           * DESC` is the newest-version rule written once, in the place that
           * can use the unique index on (visit_id, snapshot_version).
           */
          await tx
            .selectDistinctOn([financialSnapshots.visitId])
            .from(financialSnapshots)
            .where(inArray(financialSnapshots.visitId, visitIds))
            .orderBy(financialSnapshots.visitId, desc(financialSnapshots.snapshotVersion)),
          await tx.select().from(visitLines).where(inArray(visitLines.visitId, visitIds)),
        ];

  const snapshotOf = new Map(snapshots.map((snapshot) => [snapshot.visitId, snapshot]));
  const linesOf = new Map<string, typeof lines>();
  for (const line of lines) linesOf.set(line.visitId, [...(linesOf.get(line.visitId) ?? []), line]);

  const detailed = visitRows.map(({ visit, clientName }) => ({
    visit,
    snapshot: snapshotOf.get(visit.id),
    lines: linesOf.get(visit.id) ?? [],
    clientName: clientName ?? null,
  }));

  /*
   * Photos of work, one query for the whole page and only for whoever may
   * see them — an Analyst reads visits but not pictures of clients' hands,
   * and the rows are not even fetched for them.
   */
  const photoRows =
    showsPhotos && visitIds.length > 0
      ? await tx
          .select({
            id: visitPhotos.id,
            visitId: visitPhotos.visitId,
            width: visitPhotos.width,
            height: visitPhotos.height,
          })
          .from(visitPhotos)
          .where(inArray(visitPhotos.visitId, visitIds))
          .orderBy(asc(visitPhotos.createdAt))
      : [];

  return { detailed, people, photoRows, canFilterBySpecialist: ownSpecialistId === null };
}
