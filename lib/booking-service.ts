import { and, eq, gt, inArray, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";

import { bookingHolds, bookingLines, bookings } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { createBookingToken, type BookingToken } from "@/domain/booking-token";
import type { Interval } from "@/domain/interval";
import type { LocalizedText } from "@/i18n/localized-text";

/**
 * Double-booking protection, roadmap section 7.5.
 *
 * Four mechanisms, and each covers what the others cannot:
 *
 *   1. the availability engine never offers a slot that is already taken;
 *   2. a transaction-level advisory lock serializes everyone competing for one
 *      specialist on one local day, so the check below cannot be raced;
 *   3. the check itself looks at both bookings and live holds — two tables, so
 *      no single constraint can see both;
 *   4. PostgreSQL exclusion constraints refuse an overlap outright, which is
 *      what holds if a future code path forgets steps 2 and 3.
 *
 * Only the fourth is impossible to get wrong later, which is why it exists even
 * though the first three should make it unreachable.
 */
export const HOLD_TTL_MINUTES = 5;

/** The statuses that occupy a specialist; the rest free the slot. */
export const ACTIVE_BOOKING_STATUSES = ["pending_confirmation", "confirmed"] as const;

export type BookingConflict = "booking" | "hold";

export type BookingLineInput = Readonly<{
  kind: "service" | "add_on";
  serviceId?: string | null;
  addOnId?: string | null;
  nameSnapshot: LocalizedText;
  priceMinor: number;
  durationMinutes: number;
}>;

export type SlotResources = Readonly<{
  specialistId: string;
  workplaceId?: string | null;
  at: Date;
}>;

/**
 * One lock per contended resource per local day.
 *
 * Per resource because that is what is competed for; per day because a studio's
 * whole calendar behind one lock would serialize unrelated bookings in a busy
 * salon. The locks are transaction-level, so they are released by commit or
 * rollback and never leak.
 *
 * The workplace is locked as well as the specialist, and that is not symmetry
 * for its own sake: two *different* specialists booking the one chair take two
 * different specialist locks, walk into the insert together, and each waits on
 * the other's uncommitted row while PostgreSQL checks the workplace exclusion
 * constraint. That is a deadlock — 40P01, both transactions killed — where the
 * studio should have seen one booking and one `SLOT_UNAVAILABLE`. A concurrency
 * test for the shared chair is what found it.
 *
 * Keys are sorted before they are taken, for the same reason the reschedule
 * below sorts its pair: two callers acquiring the same two locks in opposite
 * orders is the other way to build a deadlock.
 */
export function resourceDayKeys(
  organizationId: string,
  resources: readonly SlotResources[],
): string[] {
  const keys = resources.flatMap((resource) => {
    const day = resource.at.toISOString().slice(0, 10);
    return [
      `${organizationId}:specialist:${resource.specialistId}:${day}`,
      ...(resource.workplaceId
        ? [`${organizationId}:workplace:${resource.workplaceId}:${day}`]
        : []),
    ];
  });

  return [...new Set(keys)].sort();
}

export async function lockResourceDays(tx: TenantTransaction, keys: readonly string[]) {
  for (const key of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

/** The common case: everything one slot touches, in one call. */
export async function lockSlotResources(
  tx: TenantTransaction,
  organizationId: string,
  resources: SlotResources,
) {
  await lockResourceDays(tx, resourceDayKeys(organizationId, [resources]));
}

/**
 * Marks holds that have run out as expired.
 *
 * Called before every conflict check, because the exclusion constraint on
 * active holds cannot express expiry — `now()` is not immutable and may not
 * appear in an index predicate. Without this, one abandoned form would keep a
 * slot unbookable until a background job noticed.
 */
export async function expireStaleHolds(tx: TenantTransaction, specialistId: string, now: Date) {
  await tx
    .update(bookingHolds)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(bookingHolds.specialistId, specialistId),
        eq(bookingHolds.status, "active"),
        lte(bookingHolds.expiresAt, now),
      ),
    );
}

/** The sweep section 7.5 asks to run at least once a minute, tenant-wide. */
export async function sweepExpiredHolds(tx: TenantTransaction, now: Date) {
  const released = await tx
    .update(bookingHolds)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(bookingHolds.status, "active"), lte(bookingHolds.expiresAt, now)))
    .returning({ id: bookingHolds.id });

  return released.length;
}

export type ConflictQuery = Readonly<{
  specialistId: string;
  workplaceId?: string | null;
  interval: Interval;
  /** The hold being converted, which must not be treated as its own conflict. */
  ignoreHoldId?: string | null;
  /** The booking being moved, which must not collide with where it already is. */
  ignoreBookingId?: string | null;
  now: Date;
}>;

/**
 * Whether anything already occupies the slot.
 *
 * Overlap is half-open on both sides: a booking ending at 10:00 does not
 * conflict with one starting at 10:00, which is what back-to-back clients are.
 */
export async function findConflict(
  tx: TenantTransaction,
  query: ConflictQuery,
): Promise<BookingConflict | null> {
  const { start, end } = query.interval;

  const overlappingBookings = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        lt(bookings.startsAt, end),
        gt(bookings.endsAt, start),
        query.workplaceId
          ? or(eq(bookings.specialistId, query.specialistId), eq(bookings.workplaceId, query.workplaceId))
          : eq(bookings.specialistId, query.specialistId),
        query.ignoreBookingId ? ne(bookings.id, query.ignoreBookingId) : undefined,
      ),
    )
    .limit(1);

  if (overlappingBookings.length > 0) return "booking";

  const overlappingHolds = await tx
    .select({ id: bookingHolds.id })
    .from(bookingHolds)
    .where(
      and(
        query.workplaceId
          ? or(
              eq(bookingHolds.specialistId, query.specialistId),
              eq(bookingHolds.workplaceId, query.workplaceId),
            )
          : eq(bookingHolds.specialistId, query.specialistId),
        eq(bookingHolds.status, "active"),
        gt(bookingHolds.expiresAt, query.now),
        lt(bookingHolds.startsAt, end),
        gt(bookingHolds.endsAt, start),
        query.ignoreHoldId ? ne(bookingHolds.id, query.ignoreHoldId) : undefined,
      ),
    )
    .limit(1);

  return overlappingHolds.length > 0 ? "hold" : null;
}

export type HoldInput = Readonly<{
  organizationId: string;
  locationId: string;
  specialistId: string;
  workplaceId?: string | null;
  interval: Interval;
  now: Date;
  ttlMinutes?: number;
}>;

export type HoldResult =
  | Readonly<{ ok: true; holdId: string; expiresAt: Date; token: BookingToken }>
  | Readonly<{ ok: false; conflict: BookingConflict }>;

/**
 * Reserves a slot for the few minutes a client needs to type their name.
 *
 * Without it the last step of the public flow is a lottery: the slot shown on
 * the previous screen can be taken while the form is being filled in. With it,
 * the loser of that race is told at the moment they pick a time.
 */
export async function holdSlot(tx: TenantTransaction, input: HoldInput): Promise<HoldResult> {
  await lockSlotResources(tx, input.organizationId, {
    specialistId: input.specialistId,
    workplaceId: input.workplaceId,
    at: input.interval.start,
  });
  await expireStaleHolds(tx, input.specialistId, input.now);

  const conflict = await findConflict(tx, {
    specialistId: input.specialistId,
    workplaceId: input.workplaceId,
    interval: input.interval,
    now: input.now,
  });
  if (conflict) return { ok: false, conflict };

  const token = createBookingToken(input.organizationId, "hold");
  const expiresAt = new Date(
    input.now.getTime() + (input.ttlMinutes ?? HOLD_TTL_MINUTES) * 60_000,
  );

  const [hold] = await tx
    .insert(bookingHolds)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      specialistId: input.specialistId,
      workplaceId: input.workplaceId ?? null,
      startsAt: input.interval.start,
      endsAt: input.interval.end,
      tokenHash: token.tokenHash,
      expiresAt,
    })
    .returning({ id: bookingHolds.id });

  return { ok: true, holdId: hold.id, expiresAt, token };
}

export async function releaseHold(tx: TenantTransaction, holdId: string, now: Date) {
  await tx
    .update(bookingHolds)
    .set({ status: "released", updatedAt: now })
    .where(and(eq(bookingHolds.id, holdId), eq(bookingHolds.status, "active")));
}

export type CreateBookingInput = Readonly<{
  organizationId: string;
  locationId: string;
  specialistId: string;
  workplaceId?: string | null;
  clientId?: string | null;
  interval: Interval;
  source: "public_booking" | "staff" | "rebooking" | "waitlist" | "import" | "api";
  /** `instant` confirms on creation; `manual` leaves a request the studio answers. */
  confirmationMode: "instant" | "manual";
  confirmationTtlMinutes?: number;
  lines: readonly BookingLineInput[];
  actorUserId: string | null;
  holdId?: string | null;
  now: Date;
}>;

export type CreateBookingResult =
  | Readonly<{ ok: true; bookingId: string; status: "pending_confirmation" | "confirmed" }>
  | Readonly<{ ok: false; conflict: BookingConflict }>;

/**
 * Creates a booking, or refuses because the slot went while the caller was
 * deciding.
 *
 * Availability, the conflict check and the insert happen in one transaction
 * under one lock, which is section 7.5's requirement stated plainly: a check
 * that commits separately from the write it authorises has authorised nothing.
 */
export async function createBooking(
  tx: TenantTransaction,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  await lockSlotResources(tx, input.organizationId, {
    specialistId: input.specialistId,
    workplaceId: input.workplaceId,
    at: input.interval.start,
  });
  await expireStaleHolds(tx, input.specialistId, input.now);

  const conflict = await findConflict(tx, {
    specialistId: input.specialistId,
    workplaceId: input.workplaceId,
    interval: input.interval,
    ignoreHoldId: input.holdId ?? null,
    now: input.now,
  });
  if (conflict) return { ok: false, conflict };

  const status = input.confirmationMode === "instant" ? "confirmed" : "pending_confirmation";

  // A manual request holds the slot until the studio answers — an unanswered
  // request still stops someone else taking the time — but never past the
  // appointment itself, which would leave a booking nobody can act on.
  const confirmationDueAt =
    status === "pending_confirmation"
      ? new Date(
          Math.min(
            input.now.getTime() + (input.confirmationTtlMinutes ?? 120) * 60_000,
            input.interval.start.getTime(),
          ),
        )
      : null;

  const [booking] = await tx
    .insert(bookings)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      specialistId: input.specialistId,
      workplaceId: input.workplaceId ?? null,
      clientId: input.clientId ?? null,
      startsAt: input.interval.start,
      endsAt: input.interval.end,
      status,
      source: input.source,
      confirmationDueAt,
      confirmedAt: status === "confirmed" ? input.now : null,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    })
    .returning({ id: bookings.id });

  if (input.lines.length > 0) {
    await tx.insert(bookingLines).values(
      input.lines.map((line) => ({
        organizationId: input.organizationId,
        bookingId: booking.id,
        kind: line.kind,
        serviceId: line.serviceId ?? null,
        addOnId: line.addOnId ?? null,
        nameSnapshot: line.nameSnapshot,
        priceMinor: line.priceMinor,
        durationMinutes: line.durationMinutes,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })),
    );
  }

  if (input.holdId) {
    await tx
      .update(bookingHolds)
      .set({ status: "converted", convertedBookingId: booking.id, updatedAt: input.now })
      .where(and(eq(bookingHolds.id, input.holdId), eq(bookingHolds.status, "active")));
  }

  return { ok: true, bookingId: booking.id, status };
}

/** Live holds a caller still owns, for the availability engine's busy list. */
export async function activeHoldIntervals(
  tx: TenantTransaction,
  specialistId: string,
  now: Date,
): Promise<Interval[]> {
  const rows = await tx
    .select({ start: bookingHolds.startsAt, end: bookingHolds.endsAt })
    .from(bookingHolds)
    .where(
      and(
        eq(bookingHolds.specialistId, specialistId),
        eq(bookingHolds.status, "active"),
        gt(bookingHolds.expiresAt, now),
      ),
    );

  return rows.map((row) => ({ start: row.start, end: row.end }));
}

/** Bookings that occupy the specialist, for the same busy list. */
export async function activeBookingIntervals(
  tx: TenantTransaction,
  specialistId: string,
  window: Interval,
  /** A booking being moved does not compete with itself; see `SlotQuery`. */
  excludeBookingId: string | null = null,
): Promise<Interval[]> {
  const rows = await tx
    .select({ start: bookings.startsAt, end: bookings.endsAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.specialistId, specialistId),
        inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        lt(bookings.startsAt, window.end),
        gt(bookings.endsAt, window.start),
        excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined,
      ),
    );

  return rows.map((row) => ({ start: row.start, end: row.end }));
}

/* --- The lifecycle a booking moves through, roadmap sections 7.2 and 7.6 --- */

export type BookingStatus = (typeof bookings.$inferSelect)["status"];
export type BookingRow = typeof bookings.$inferSelect;

/**
 * Which status may follow which.
 *
 * Written out rather than derived, because the interesting entries are the
 * empty ones: `cancelled`, `completed` and `no_show` are terminal, and a
 * booking that could leave one would let a cancellation be undone by a request
 * arriving late — the client has already been told it is off.
 *
 * `completed` and `no_show` are reachable only from `confirmed`. Marking a
 * no-show on a request the studio never answered records the client's failure
 * to attend something that was never arranged.
 */
export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  pending_confirmation: ["confirmed", "cancelled"],
  confirmed: ["cancelled", "completed", "no_show"],
  cancelled: [],
  completed: [],
  no_show: [],
};

/** The statuses a booking may still be moved to another time from. */
export const RESCHEDULABLE_STATUSES: readonly BookingStatus[] = ["pending_confirmation", "confirmed"];

/**
 * Why an appointment was called off, as codes rather than free text.
 *
 * Section 7.9 keeps PII out of booking columns, and a free-text reason typed
 * while on the phone with a client is exactly where a phone number or a medical
 * detail ends up. `confirmation_expired` is missing on purpose: only the repair
 * job writes it, and a member of staff choosing it would be recording something
 * that did not happen.
 */
export const STAFF_CANCELLATION_REASONS = [
  "client_request",
  "studio_request",
  "no_contact",
  "duplicate",
  "other",
] as const;

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export async function loadBooking(tx: TenantTransaction, bookingId: string): Promise<BookingRow | null> {
  const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  return booking ?? null;
}

export type MutationFailure =
  | Readonly<{ ok: false; failure: "not_found" }>
  | Readonly<{ ok: false; failure: "version_conflict"; current: number }>
  | Readonly<{ ok: false; failure: "illegal_transition"; from: BookingStatus }>
  | Readonly<{ ok: false; failure: "conflict"; conflict: BookingConflict }>;

export type TransitionInput = Readonly<{
  bookingId: string;
  to: BookingStatus;
  expectedVersion?: number | null;
  /** Who ended it, for a cancellation. The schema refuses one without the other. */
  actor?: "client" | "staff" | "system";
  /** A short code, never free text: section 7.9 keeps PII out of this column. */
  reason?: string | null;
  actorUserId: string | null;
  now: Date;
}>;

/**
 * Moves a booking to its next status, or explains why it cannot go there.
 *
 * The version is matched in the `WHERE` clause rather than compared after a
 * read: two staff members answering the same pending request at the same moment
 * both read version 1, and only the row that the update actually matched may
 * claim to have changed anything.
 */
export async function transitionBooking(
  tx: TenantTransaction,
  input: TransitionInput,
): Promise<Readonly<{ ok: true; booking: BookingRow }> | MutationFailure> {
  const booking = await loadBooking(tx, input.bookingId);
  if (!booking) return { ok: false, failure: "not_found" };

  if (input.expectedVersion != null && booking.version !== input.expectedVersion) {
    return { ok: false, failure: "version_conflict", current: booking.version };
  }
  if (!canTransition(booking.status, input.to)) {
    return { ok: false, failure: "illegal_transition", from: booking.status };
  }

  const cancelling = input.to === "cancelled";
  const [updated] = await tx
    .update(bookings)
    .set({
      status: input.to,
      confirmedAt: input.to === "confirmed" ? input.now : booking.confirmedAt,
      // A confirmed booking has nothing left to answer; leaving the deadline
      // behind would make the repair job cancel an appointment that is on.
      confirmationDueAt: input.to === "confirmed" ? null : booking.confirmationDueAt,
      completedAt: input.to === "completed" ? input.now : booking.completedAt,
      cancelledAt: cancelling ? input.now : null,
      cancelledBy: cancelling ? (input.actor ?? "staff") : null,
      cancellationReason: cancelling ? (input.reason ?? null) : null,
      updatedAt: input.now,
      updatedBy: input.actorUserId,
      version: booking.version + 1,
    })
    .where(and(eq(bookings.id, booking.id), eq(bookings.version, booking.version)))
    .returning();

  if (!updated) return { ok: false, failure: "version_conflict", current: booking.version };
  return { ok: true, booking: updated };
}

export type RescheduleInput = Readonly<{
  organizationId: string;
  bookingId: string;
  interval: Interval;
  /** Moving the appointment to a colleague is a reschedule too. */
  specialistId?: string | null;
  workplaceId?: string | null;
  expectedVersion?: number | null;
  actorUserId: string | null;
  now: Date;
}>;

/**
 * Moves a booking to another time, under the same protection as creating one.
 *
 * The lock is taken on the destination day and the check ignores the booking
 * being moved: an appointment cannot conflict with where it already is, and
 * without that exception every same-day reschedule would refuse itself.
 */
export async function rescheduleBooking(
  tx: TenantTransaction,
  input: RescheduleInput,
): Promise<Readonly<{ ok: true; booking: BookingRow; previous: Interval }> | MutationFailure> {
  const booking = await loadBooking(tx, input.bookingId);
  if (!booking) return { ok: false, failure: "not_found" };

  if (input.expectedVersion != null && booking.version !== input.expectedVersion) {
    return { ok: false, failure: "version_conflict", current: booking.version };
  }
  if (!RESCHEDULABLE_STATUSES.includes(booking.status)) {
    return { ok: false, failure: "illegal_transition", from: booking.status };
  }

  const specialistId = input.specialistId ?? booking.specialistId;
  const workplaceId = input.workplaceId === undefined ? booking.workplaceId : input.workplaceId;

  // Where it is now and where it is going: both have to be held, because the
  // slot being vacated becomes bookable the moment this commits. Deduplicated
  // and sorted by `resourceDayKeys`, so two reschedules trading a pair of days
  // cannot deadlock by taking the same two locks in opposite orders.
  await lockResourceDays(
    tx,
    resourceDayKeys(input.organizationId, [
      { specialistId: booking.specialistId, workplaceId: booking.workplaceId, at: booking.startsAt },
      { specialistId, workplaceId, at: input.interval.start },
    ]),
  );

  await expireStaleHolds(tx, specialistId, input.now);

  const conflict = await findConflict(tx, {
    specialistId,
    workplaceId,
    interval: input.interval,
    ignoreBookingId: booking.id,
    now: input.now,
  });
  if (conflict) return { ok: false, failure: "conflict", conflict };

  const [updated] = await tx
    .update(bookings)
    .set({
      specialistId,
      workplaceId,
      startsAt: input.interval.start,
      endsAt: input.interval.end,
      // A request that has not been answered stays unanswered at its new time,
      // but never past the appointment it is holding.
      confirmationDueAt:
        booking.status === "pending_confirmation" && booking.confirmationDueAt
          ? new Date(Math.min(booking.confirmationDueAt.getTime(), input.interval.start.getTime()))
          : booking.confirmationDueAt,
      updatedAt: input.now,
      updatedBy: input.actorUserId,
      version: booking.version + 1,
    })
    .where(and(eq(bookings.id, booking.id), eq(bookings.version, booking.version)))
    .returning();

  if (!updated) return { ok: false, failure: "version_conflict", current: booking.version };

  return {
    ok: true,
    booking: updated,
    previous: { start: booking.startsAt, end: booking.endsAt },
  };
}

/** The lines a booking carries, for its card and for closing it into a visit. */
export async function bookingLinesOf(tx: TenantTransaction, bookingId: string) {
  return tx.select().from(bookingLines).where(eq(bookingLines.bookingId, bookingId));
}

/**
 * Bookings whose confirmation window has passed, section 7.4: a manual request
 * the studio never answered stops holding the slot.
 */
export async function expireUnconfirmedBookings(tx: TenantTransaction, now: Date) {
  const expired = await tx
    .update(bookings)
    .set({
      status: "cancelled",
      cancelledAt: now,
      cancelledBy: "system",
      cancellationReason: "confirmation_expired",
      updatedAt: now,
      version: sql`${bookings.version} + 1`,
    })
    .where(
      and(
        eq(bookings.status, "pending_confirmation"),
        isNotNull(bookings.confirmationDueAt),
        lte(bookings.confirmationDueAt, now),
      ),
    )
    .returning({ id: bookings.id });

  return expired.length;
}
