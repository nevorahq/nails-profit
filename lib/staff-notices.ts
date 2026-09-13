import { and, desc, eq, gte, sql } from "drizzle-orm";

import { bookings, clients, memberships, specialists, staffNotices } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { scopedSpecialistId, type CalendarActor } from "@/lib/booking-access";

export type StaffNoticeKind =
  | "client_booked"
  | "client_rescheduled"
  | "client_cancelled"
  | "client_released"
  | "staff_rescheduled"
  | "staff_cancelled";

/**
 * How far back the bell looks.
 *
 * A month, because that is the horizon a studio still acts on: an hour freed
 * three weeks ago is history, not news, and a list that keeps everything turns
 * the one thing that happened this morning into something to scroll for. Old
 * rows are left in the table rather than deleted here — pruning belongs to the
 * maintenance job, not to a page load.
 */
const FEED_WINDOW_DAYS = 30;
const FEED_LIMIT = 50;

/**
 * A row per event, written in the transaction that caused it.
 *
 * Beside the outbox rather than inside it: a message is delivered to an address
 * and a notice is shown to whoever opens the app, so one is written per
 * recipient and the other once. Both are written where the change happens, for
 * the same reason — a fifth staff action cannot ship without telling anyone if
 * telling is part of making the change.
 */
export async function recordStaffNotice(
  tx: TenantTransaction,
  input: Readonly<{
    organizationId: string;
    bookingId: string;
    kind: StaffNoticeKind;
    /** Whose day this is about — not always the booking's current master. */
    specialistId: string;
    /** Null when the client did it: they have no account to be. */
    actorUserId: string | null;
    /** Only where the booking can no longer be asked: the hour it left. */
    previousStartsAt?: Date | null;
  }>,
): Promise<void> {
  await tx.insert(staffNotices).values({
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    kind: input.kind,
    specialistId: input.specialistId,
    actorUserId: input.actorUserId,
    payload: input.previousStartsAt
      ? { previousStartsAt: input.previousStartsAt.toISOString() }
      : null,
  });
}

export type NoticeRow = Readonly<{
  id: string;
  bookingId: string;
  kind: StaffNoticeKind;
  createdAt: Date;
  previousStartsAt: string | null;
  clientName: string | null;
  specialistId: string;
  specialistName: string;
  startsAt: Date;
  timezone: string;
}>;

/**
 * What one person may read, which is not what the studio has.
 *
 * Two narrowings, and they are different in kind. A Master sees their own
 * appointments because that is the scope the role carries everywhere else, and
 * `scopedSpecialistId` is the one place that decides it. Nobody, of any role,
 * sees what they did themselves: an owner who cancels a visit does not need the
 * app to tell them so, and a bell that reports your own clicks back to you is a
 * bell people stop opening. The same reasoning already keeps the studio's copy
 * of a message from reaching the master who is the owner.
 *
 * `is distinct from` rather than `<>`: a client's notice has no actor, and
 * `actor_user_id <> 'u1'` is null — not true — for every one of them, which
 * would hide exactly the rows the feed exists for.
 */
export async function loadNoticeFeed(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; actor: CalendarActor; now?: Date }>,
): Promise<NoticeRow[]> {
  const ownSpecialistId = await scopedSpecialistId(tx, input.actor);
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - FEED_WINDOW_DAYS * 24 * 60 * 60_000);

  const rows = await tx
    .select({
      id: staffNotices.id,
      bookingId: staffNotices.bookingId,
      kind: staffNotices.kind,
      createdAt: staffNotices.createdAt,
      payload: staffNotices.payload,
      specialistId: staffNotices.specialistId,
      specialistName: specialists.name,
      clientName: clients.name,
      clientNameSnapshot: bookings.clientNameSnapshot,
      startsAt: bookings.startsAt,
      timezone: sql<string>`(select "timezone" from "location" where "location"."id" = ${bookings.locationId})`,
    })
    .from(staffNotices)
    .innerJoin(bookings, eq(bookings.id, staffNotices.bookingId))
    .innerJoin(specialists, eq(specialists.id, staffNotices.specialistId))
    .leftJoin(clients, eq(clients.id, bookings.clientId))
    .where(
      and(
        gte(staffNotices.createdAt, since),
        sql`${staffNotices.actorUserId} is distinct from ${input.actor.userId}`,
        ownSpecialistId ? eq(staffNotices.specialistId, ownSpecialistId) : undefined,
      ),
    )
    .orderBy(desc(staffNotices.createdAt))
    .limit(FEED_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    bookingId: row.bookingId,
    kind: row.kind,
    createdAt: row.createdAt,
    previousStartsAt: row.payload?.previousStartsAt ?? null,
    // The name the appointment was booked under, then the card's, the same pair
    // the bell and the calendar already show.
    clientName: row.clientNameSnapshot ?? row.clientName,
    specialistId: row.specialistId,
    specialistName: row.specialistName,
    startsAt: row.startsAt,
    timezone: row.timezone,
  }));
}

export type NoticeGroup = Readonly<{
  bookingId: string;
  /** The latest event: what the row says happened. */
  kind: StaffNoticeKind;
  at: Date;
  /** What happened before it, oldest first — «перенесла, затем отменила». */
  earlier: readonly StaffNoticeKind[];
  /** The hour the appointment sat at before the first move in this group. */
  previousStartsAt: string | null;
  unread: boolean;
  row: NoticeRow;
}>;

/**
 * One appointment, one line.
 *
 * A client who moves a visit twice and then calls it off has produced one
 * story, not three, and it points at one day and one hour. Grouping by the
 * booking is what collapses it; grouping by the client would not — two visits
 * of the same person on two days are two holes in the calendar, and merging
 * them hides one.
 *
 * Done here, on rows already read, rather than in SQL: the shape is a decision
 * about reading, and keeping it out of the query is what makes it cheap to
 * change if a flat list turns out to read better.
 */
export function groupNotices(rows: readonly NoticeRow[], readAt: Date | null): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();

  // Newest first, so the first row of a booking is the one the line is about.
  for (const row of rows) {
    const seen = groups.get(row.bookingId);
    const unread = readAt === null || row.createdAt > readAt;

    if (!seen) {
      groups.set(row.bookingId, {
        bookingId: row.bookingId,
        kind: row.kind,
        at: row.createdAt,
        earlier: [],
        previousStartsAt: row.previousStartsAt,
        unread,
        row,
      });
      continue;
    }

    groups.set(row.bookingId, {
      ...seen,
      // Oldest first: this row is older than everything already collected.
      earlier: [row.kind, ...seen.earlier],
      /*
       * The earliest hour known to the group. A visit moved twice should say
       * where it started, not where the last move found it.
       */
      previousStartsAt: row.previousStartsAt ?? seen.previousStartsAt,
      unread: seen.unread || unread,
    });
  }

  return [...groups.values()].sort((left, right) => right.at.getTime() - left.at.getTime());
}

/** Everything up to this moment has been seen. */
export async function markNoticesRead(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; userId: string; now: Date }>,
): Promise<void> {
  await tx
    .update(memberships)
    .set({ noticesReadAt: input.now })
    .where(
      and(
        eq(memberships.organizationId, input.organizationId),
        eq(memberships.userId, input.userId),
      ),
    );
}

export async function noticesReadAt(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; userId: string }>,
): Promise<Date | null> {
  const [row] = await tx
    .select({ readAt: memberships.noticesReadAt })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, input.organizationId),
        eq(memberships.userId, input.userId),
      ),
    )
    .limit(1);

  return row?.readAt ?? null;
}
