/**
 * Whom to offer an hour that a cancellation gave back.
 *
 * The list is «Пора позвать» (`domain/client-return.ts`) — clients past their
 * own rhythm with nothing booked — narrowed and reordered for one particular
 * hour. Nothing here decides that somebody is due; it only decides who among
 * the due is likeliest to take *this* hour, and how many of them are worth
 * the desk's attention.
 *
 * Likeliest means the master first: a client whose last visit was with this
 * master is asking for them by habit, and a message offering someone else's
 * hour is a worse message. The service comes second — it fits the time they
 * would have to set aside — and freshness of the lapse last, as in the list
 * itself: a client a week late answers more often than one gone for a year.
 */

/** How many clients one hour is offered to: a handful to write to, not a mailing. */
export const SLOT_FILL_LIMIT = 5;

export type SlotFillCandidate = Readonly<{
  clientId: string;
  name: string;
  /** Without a number there is nobody to write to: left out, not drawn as a dead row. */
  phone: string | null;
  /** Days past the client's own interval, from `returnDue`. */
  overdueDays: number;
  lastSpecialistId: string;
  /** Every service the client has had done, from the visits that closed. */
  serviceIds: readonly string[];
}>;

export type SlotFillWindow = Readonly<{
  specialistId: string;
  /** The services the cancelled appointment was booked for. */
  serviceIds: readonly string[];
  /** Whose appointment it was: the one client who has just said they cannot come. */
  clientId: string | null;
}>;

/**
 * The people to write to, best first, at most `limit`.
 *
 * Generic so the caller keeps whatever else it carries on a row — channels,
 * language — without this module having to know about it.
 */
export function rankSlotFill<T extends SlotFillCandidate>(
  candidates: readonly T[],
  window: SlotFillWindow,
  limit: number = SLOT_FILL_LIMIT,
): T[] {
  const wanted = new Set(window.serviceIds);

  const scored = candidates
    // The client who cancelled is not offered the hour they just gave up.
    .filter((candidate) => candidate.clientId !== window.clientId && candidate.phone !== null)
    .map((candidate) => ({
      candidate,
      sameMaster: candidate.lastSpecialistId === window.specialistId,
      sameService: candidate.serviceIds.some((id) => wanted.has(id)),
    }));

  scored.sort(
    (left, right) =>
      Number(right.sameMaster) - Number(left.sameMaster) ||
      Number(right.sameService) - Number(left.sameService) ||
      left.candidate.overdueDays - right.candidate.overdueDays ||
      left.candidate.name.localeCompare(right.candidate.name) ||
      left.candidate.clientId.localeCompare(right.candidate.clientId),
  );

  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.candidate);
}

/**
 * When the hour is, as the wall clock of the studio: «суббота, 31 октября, 14:00».
 *
 * Read in the location's timezone and never UTC — `toISOString` would offer a
 * client a time two or three hours off in Chișinău. The tag is the client's
 * language, so the weekday and month come out in the words of the message
 * around them.
 */
export function describeSlotStart(startsAt: Date, timezone: string, localeTag: string): string {
  const date = new Intl.DateTimeFormat(localeTag, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: timezone,
  }).format(startsAt);
  const time = new Intl.DateTimeFormat(localeTag, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(startsAt);
  return `${date}, ${time}`;
}

export type SlotFillRefusal ="not_cancelled" | "in_past";

/**
 * Why an appointment is not an hour to offer, or null when it is.
 *
 * Cancelled, because anything else still holds the hour. In the future,
 * because a message about a time that has gone is noise. Whether somebody has
 * booked the hour since is a question for the database and is asked there.
 */
export function slotFillRefusal(
  booking: Readonly<{ status: string; startsAt: Date }>,
  now: Date,
): SlotFillRefusal | null {
  if (booking.status !== "cancelled") return "not_cancelled";
  if (booking.startsAt.getTime() <= now.getTime()) return "in_past";
  return null;
}
