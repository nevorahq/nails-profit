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

/**
 * One lock per specialist per local day.
 *
 * Per specialist because that is the resource being competed for; per day
 * because a studio's whole calendar behind one lock would serialize unrelated
 * bookings in a busy salon. The lock is transaction-level, so it is released by
 * commit or rollback and never leaks.
 */
export async function lockSpecialistDay(
  tx: TenantTransaction,
  organizationId: string,
  specialistId: string,
  startsAt: Date,
) {
  const day = startsAt.toISOString().slice(0, 10);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${specialistId}:${day}`}, 0))`,
  );
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
      ),
    )
    .limit(1);

  if (overlappingBookings.length > 0) return "booking";

  const overlappingHolds = await tx
    .select({ id: bookingHolds.id })
    .from(bookingHolds)
    .where(
      and(
        eq(bookingHolds.specialistId, query.specialistId),
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
  await lockSpecialistDay(tx, input.organizationId, input.specialistId, input.interval.start);
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
  await lockSpecialistDay(tx, input.organizationId, input.specialistId, input.interval.start);
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
      ),
    );

  return rows.map((row) => ({ start: row.start, end: row.end }));
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
