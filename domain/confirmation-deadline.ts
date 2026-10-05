/**
 * Until when a manual request waits for the studio, decided 02.10.2026.
 *
 * The window used to be two hours from the request, capped at the appointment
 * itself. Two hours is shorter than one client's manicure: a master with her
 * hands full came back to a request that had already cancelled itself, and the
 * client had already been told the studio did not answer. So the window is now
 * the studio's own setting — twelve hours for a new address — and the cap
 * moves earlier, to two hours before the visit: a client must hear «нет» while
 * there is still time to book somewhere else, not on the way to the door.
 *
 * The two-hour reserve is a rule of the formula rather than a setting, so it
 * holds for addresses whose window was chosen before it existed.
 */

/** The window a new address starts with; `booking_settings` holds the rest. */
export const DEFAULT_CONFIRMATION_TTL_MINUTES = 720;

/** The client hears the answer at least this long before the visit. */
export const CONFIRMATION_RESERVE_MINUTES = 120;

/**
 * Never less than this, however close the visit: the smallest window the
 * settings allow. A request for an hour from now would otherwise lapse the
 * moment it was made — or before — and the studio would never see it at all.
 */
export const MIN_CONFIRMATION_MINUTES = 15;

const MINUTE = 60_000;

/**
 * `min(now + ttl, max(start − reserve, now + 15 min), start)`.
 *
 * The middle term is the reserve giving way to the floor when the visit is too
 * close for both; the last is the old rule that still holds underneath — no
 * request waits past its own appointment, so a visit ten minutes away waits ten
 * minutes, not fifteen.
 */
export function confirmationDeadline(input: Readonly<{
  now: Date;
  ttlMinutes: number;
  startsAt: Date;
}>): Date {
  const now = input.now.getTime();
  const start = input.startsAt.getTime();

  const byWindow = now + input.ttlMinutes * MINUTE;
  const byReserve = Math.max(start - CONFIRMATION_RESERVE_MINUTES * MINUTE, now + MIN_CONFIRMATION_MINUTES * MINUTE);

  return new Date(Math.min(byWindow, byReserve, start));
}

/**
 * The same deadline after a pending request moves to another hour.
 *
 * The clock the studio was given keeps running — moving a request is not
 * answering it — but the new hour may be closer than the old one, and then the
 * reserve pulls the deadline in. Never later than it was: a client who moves a
 * request does not buy the studio more time to ignore it.
 */
export function movedConfirmationDeadline(input: Readonly<{
  current: Date;
  now: Date;
  startsAt: Date;
}>): Date {
  const now = input.now.getTime();
  const start = input.startsAt.getTime();
  const byReserve = Math.max(start - CONFIRMATION_RESERVE_MINUTES * MINUTE, now + MIN_CONFIRMATION_MINUTES * MINUTE);

  return new Date(Math.min(input.current.getTime(), byReserve, start));
}

/**
 * Half of the window, when the studio is reminded once that a request is still
 * waiting. Measured from the request itself, so a moved request keeps the
 * midpoint of the time it actually had.
 */
export function confirmationMidpoint(input: Readonly<{ createdAt: Date; dueAt: Date }>): Date {
  const created = input.createdAt.getTime();
  return new Date(created + (input.dueAt.getTime() - created) / 2);
}
