/**
 * Dates counted from today, for suites that talk to a running clock.
 *
 * A date written into a test is true until the calendar passes it, and then it
 * is quietly something else. Every one of these cost a red build on 2 September
 * 2026, and none of the failures were about the code:
 *
 * - a queue dispatched at a moment already gone claimed nothing, because rows
 *   enter it at the database's own `now()`;
 * - a rota was asked for the rules in force *today* and filtered down to a
 *   Wednesday in August that a later rota had since closed;
 * - a day the suite had booked against ran out of slots by mid-afternoon, so
 *   the answer became "next week" depending on the hour the run started;
 * - and a visit could no longer be closed the moment the appointment it
 *   belonged to stopped being in the past.
 *
 * The rule those share: a fixed date is safe only where nothing compares it to
 * the real clock — a pure function handed its own `now`, or a row whose times
 * the test writes on both sides. Anywhere the application is asked what is
 * free, due, or already over, the date has to be counted from today.
 */

/** The local date, as the API and the rota tables spell it. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The nth occurrence of a weekday ahead of today, never today itself.
 *
 * Weekdays are ISO — Monday is 1, Sunday is 7 — matching `availability/rules`.
 * Noon UTC so that the date is the same one in the studio's own zone, which is
 * east of it; the callers only ever read the day.
 *
 * "Never today" is deliberate. A rota that opens at nine and a service that
 * runs ninety minutes leave today with nothing to offer by late afternoon, and
 * a suite that books today is a suite whose result depends on the hour it ran.
 */
export function weekdayAhead(weekday: number, nth = 1): Date {
  const day = new Date();
  day.setUTCHours(12, 0, 0, 0);
  do {
    day.setUTCDate(day.getUTCDate() + 1);
  } while (day.getUTCDay() % 7 !== weekday % 7);
  day.setUTCDate(day.getUTCDate() + (nth - 1) * 7);
  return day;
}

/**
 * The nth Wednesday ahead, as a local date.
 *
 * Wednesday because that is the day the booking fixtures put their rota on, and
 * `nth` because a suite whose tests each take a week of their own never has two
 * of them competing for one slot.
 */
export function wednesdayAhead(nth = 1): string {
  return isoDay(weekdayAhead(3, nth));
}
