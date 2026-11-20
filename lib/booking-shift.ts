import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";

import { bookings } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { movedConfirmationDeadline } from "@/domain/confirmation-deadline";
import { planShift, shiftWriteOrder, type ShiftMove, type ShiftRefusal } from "@/domain/booking-shift";
import type { Interval } from "@/domain/interval";
import { loadSlotContext, workingHoursIn } from "@/lib/availability-service";
import {
  ACTIVE_BOOKING_STATUSES,
  expireStaleHolds,
  findConflict,
  loadBooking,
  lockResourceDays,
  resourceDayKeys,
  type BookingConflict,
  type BookingRow,
} from "@/lib/booking-service";

/**
 * Thrown from inside the transaction when a write loses to another writer after
 * earlier ones have succeeded. Returning would commit those; throwing rolls the
 * whole chain back, which is what "all or nothing" means.
 */
export class ShiftVersionConflict extends Error {
  constructor() {
    super("A booking in the chain changed while it was being moved");
    this.name = "ShiftVersionConflict";
  }
}

/** More than a day's worth of back-to-back appointments is not one chain. */
const MAX_CHAIN = 30;

export type ShiftFollowingInput = Readonly<{
  organizationId: string;
  /** The visit that ran short or long. It is not moved; what comes after it is. */
  anchorBookingId: string;
  /** Minutes, negative for earlier. */
  deltaMinutes: number;
  /**
   * The versions the person looking at the preview saw, by booking id. When
   * given, the chain computed now has to be exactly that set at exactly those
   * versions: a move applied to a day that changed under the preview would put
   * clients at hours nobody agreed to.
   */
  expectedVersions?: Readonly<Record<string, number>> | null;
  /** `preview` plans and checks; `apply` also writes. */
  mode: "preview" | "apply";
  actorUserId: string | null;
  now: Date;
}>;

export type ShiftOutcome =
  | Readonly<{
      ok: true;
      moves: readonly (ShiftMove & { booking: BookingRow })[];
      /** Only on `apply`: the rows as written. */
      applied: readonly BookingRow[];
      /** Only on `apply`: the visit corrected, as it was and as it is. */
      anchor: Readonly<{ before: Interval; after: BookingRow }> | null;
    }>
  | Readonly<{ ok: false; failure: "not_found" }>
  | Readonly<{ ok: false; failure: "illegal_transition"; from: BookingRow["status"] }>
  | Readonly<{ ok: false; failure: "version_conflict" }>
  | Readonly<{ ok: false; failure: "refused" } & ShiftRefusal>
  | Readonly<{ ok: false; failure: "conflict"; bookingId: string; conflict: BookingConflict }>;

async function loadFollowing(tx: TenantTransaction, anchor: BookingRow) {
  return tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.specialistId, anchor.specialistId),
        inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        gte(bookings.startsAt, anchor.endsAt),
        ne(bookings.id, anchor.id),
      ),
    )
    .orderBy(asc(bookings.startsAt))
    .limit(MAX_CHAIN);
}

/**
 * Moves the appointments that follow one that ran short or long.
 *
 * The anchor is the visit being corrected: closed early, or still running past
 * its booked end. Its end moves with the shift, since the calendar is a record
 * of who occupies the master's time and the table would otherwise refuse the
 * next booking onto the hour the visit no longer needs. What was agreed with the
 * client is still on the booking's lines and, once closed, on the visit.
 *
 * Under the same locks as a single move, taken for every day the chain can
 * touch before anything is read: reading the chain and then locking would plan
 * against a day somebody else is rewriting.
 */
export async function shiftFollowingBookings(
  tx: TenantTransaction,
  input: ShiftFollowingInput,
): Promise<ShiftOutcome> {
  const anchor = await loadBooking(tx, input.anchorBookingId);
  if (!anchor) return { ok: false, failure: "not_found" };
  // A cancelled appointment has no end to measure from.
  if (anchor.status === "cancelled" || anchor.status === "no_show") {
    return { ok: false, failure: "illegal_transition", from: anchor.status };
  }

  // The first read tells which resources to lock; the one under the lock is the
  // one that is planned from.
  const unlocked = await loadFollowing(tx, anchor);
  const lockAt = [anchor, ...unlocked].flatMap((row) => [
    { specialistId: row.specialistId, workplaceId: row.workplaceId, at: row.startsAt },
    { specialistId: row.specialistId, workplaceId: row.workplaceId, at: row.endsAt },
  ]);
  await lockResourceDays(tx, resourceDayKeys(input.organizationId, lockAt));
  await expireStaleHolds(tx, anchor.specialistId, input.now);

  const following = await loadFollowing(tx, anchor);

  const context = await loadSlotContext(tx, anchor.locationId);
  if (!context) return { ok: false, failure: "not_found" };

  const anchorEnd = new Date(anchor.endsAt.getTime() + input.deltaMinutes * 60_000);
  const reach: Interval = {
    start: anchor.startsAt,
    end: new Date(Math.max(...following.map((row) => row.endsAt.getTime()), anchor.endsAt.getTime()) + 86_400_000),
  };
  const working = await workingHoursIn(
    tx,
    { specialistId: anchor.specialistId, locationId: anchor.locationId, window: reach },
    context,
  );

  const plan = planShift({
    following: following.map((row) => ({ id: row.id, start: row.startsAt, end: row.endsAt })),
    deltaMinutes: input.deltaMinutes,
    anchorEnd,
    anchorStart: anchor.startsAt,
    notBefore: input.now,
    working,
  });
  if (!plan.ok) {
    const { ok: _ok, ...refusal } = plan;
    void _ok;
    return { ok: false, failure: "refused", ...refusal };
  }

  const byId = new Map(following.map((row) => [row.id, row]));
  const moves = plan.moves.map((move) => ({ ...move, booking: byId.get(move.id)! }));

  if (input.expectedVersions) {
    const expected = input.expectedVersions;
    const same =
      moves.length === Object.keys(expected).length &&
      moves.every((move) => expected[move.id] === move.booking.version);
    if (!same) return { ok: false, failure: "version_conflict" };
  }

  // The anchor is ignored as well as the chain: closed early, it still holds
  // its booked hour in the table, and the whole point is to use the end of it.
  const ignored = [anchor.id, ...moves.map((move) => move.id)];
  for (const move of moves) {
    const conflict = await findConflict(tx, {
      specialistId: move.booking.specialistId,
      workplaceId: move.booking.workplaceId,
      interval: move.to,
      ignoreBookingIds: ignored,
      now: input.now,
    });
    if (conflict) return { ok: false, failure: "conflict", bookingId: move.id, conflict };
  }

  if (input.mode === "preview") return { ok: true, moves, applied: [], anchor: null };

  const applied: BookingRow[] = [];

  /*
   * The visit corrected ends where it actually ended. Going earlier that has to
   * come first: the table refuses an overlap, and the booking pulled forward
   * lands on the hour the visit no longer needs. Going later it comes last, for
   * the mirror reason — the visit grows into time the others have just left.
   */
  const writeAnchor = async () => {
    const [updated] = await tx
      .update(bookings)
      .set({ endsAt: anchorEnd, updatedAt: input.now, updatedBy: input.actorUserId, version: anchor.version + 1 })
      .where(and(eq(bookings.id, anchor.id), eq(bookings.version, anchor.version)))
      .returning();
    if (!updated) throw new ShiftVersionConflict();
    return updated;
  };

  let corrected: BookingRow | null = null;
  if (input.deltaMinutes < 0) corrected = await writeAnchor();

  for (const move of shiftWriteOrder(moves, input.deltaMinutes)) {
    const [updated] = await tx
      .update(bookings)
      .set({
        startsAt: move.to.start,
        endsAt: move.to.end,
        confirmationDueAt:
          move.booking.status === "pending_confirmation" && move.booking.confirmationDueAt
            ? movedConfirmationDeadline({
                current: move.booking.confirmationDueAt,
                now: input.now,
                startsAt: move.to.start,
              })
            : move.booking.confirmationDueAt,
        updatedAt: input.now,
        updatedBy: input.actorUserId,
        version: move.booking.version + 1,
      })
      .where(and(eq(bookings.id, move.id), eq(bookings.version, move.booking.version)))
      .returning();

    // Lost to another writer between the read and the write.
    if (!updated) throw new ShiftVersionConflict();
    applied.push(updated);
  }

  if (input.deltaMinutes > 0) corrected = await writeAnchor();

  return {
    ok: true,
    moves,
    applied,
    anchor: { before: { start: anchor.startsAt, end: anchor.endsAt }, after: corrected! },
  };
}
