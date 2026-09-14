import { and, desc, eq, gte, sql } from "drizzle-orm";

import { bookings, clients, specialists, staffNoticeReads, staffNotices } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { scopedSpecialistId, type CalendarActor } from "@/lib/booking-access";

export type StaffNoticeKind =
  | "client_booked"
  | "client_rescheduled"
  | "client_cancelled"
  | "client_released"
  | "staff_rescheduled"
  | "staff_cancelled"
  | "staff_booked"
  | "request_expired";

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
export function groupNotices(
  rows: readonly NoticeRow[],
  reads: ReadonlyMap<string, Date>,
): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();

  // Newest first, so the first row of a booking is the one the line is about.
  for (const row of rows) {
    const seen = groups.get(row.bookingId);
    const seenThrough = reads.get(row.bookingId);
    const unread = seenThrough === undefined || row.createdAt > seenThrough;

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

  /*
   * What is still waiting, then what has been dealt with — and inside each,
   * newest first.
   *
   * The list used to be one run of time, which is right for a record of what
   * happened and wrong for a queue somebody works through: the line you opened
   * a minute ago sat above the three you have not, purely because it moved most
   * recently. Sinking it is the whole of the change, and it is a sort rather
   * than a filter on purpose — an accidental click costs the reader a line's
   * position and never the line.
   */
  return [...groups.values()].sort((left, right) => {
    if (left.unread !== right.unread) return left.unread ? -1 : 1;
    return right.at.getTime() - left.at.getTime();
  });
}

/**
 * One line of the bell, discharged.
 *
 * Written when the reader opens the appointment behind it, which is the moment
 * they have actually seen what the line was telling them. Opening the panel is
 * deliberately not that moment any more: it used to mark the whole feed read at
 * once, and a list that empties itself the moment you glance at it cannot also
 * be the list of what you still have to work through.
 *
 * `seen_through` is now rather than the event's own time, and the difference
 * only shows in a race: an event landing on this booking while the reader is
 * opening it is one they have not seen, and `now` is the honest boundary for
 * that — it leaves the new line unread rather than silently discharging it.
 */
export async function markNoticeRead(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; userId: string; bookingId: string; now: Date }>,
): Promise<void> {
  await tx
    .insert(staffNoticeReads)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      bookingId: input.bookingId,
      seenThrough: input.now,
    })
    .onConflictDoUpdate({
      target: [
        staffNoticeReads.organizationId,
        staffNoticeReads.userId,
        staffNoticeReads.bookingId,
      ],
      // Opened again: the boundary moves forward, taking whatever has happened
      // on this booking since with it.
      set: { seenThrough: input.now, updatedAt: input.now },
    });
}

/**
 * What this reader has already dealt with, as a map the feed can ask per line.
 *
 * Read in one statement for the whole feed rather than per booking: the list is
 * fifty groups at most, and fifty round trips to answer "is this one still
 * waiting" would be fifty more than the question is worth.
 */
export async function loadNoticeReads(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; userId: string }>,
): Promise<Map<string, Date>> {
  const rows = await tx
    .select({ bookingId: staffNoticeReads.bookingId, seenThrough: staffNoticeReads.seenThrough })
    .from(staffNoticeReads)
    .where(
      and(
        eq(staffNoticeReads.organizationId, input.organizationId),
        eq(staffNoticeReads.userId, input.userId),
      ),
    );

  return new Map(rows.map((row) => [row.bookingId, row.seenThrough]));
}
