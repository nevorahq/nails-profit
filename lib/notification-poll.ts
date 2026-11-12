/*
 * The bell's polling rule, apart from the component so a unit test can reach it
 * without loading a client component and everything it imports.
 */

/**
 * How often a tab on screen checks for a new request while nobody has clicked
 * the bell.
 *
 * Each check is about ten statements against a database in another region,
 * and every open tab made one twice a minute whether anybody was looking or
 * not — a studio with the app open on three devices kept the pool busy around
 * the clock, and the checks competed with the pages people were actually
 * waiting for. A minute is still well inside how fast a studio answers a
 * request, a hidden tab does not check at all, and coming back to the tab
 * checks at once — see `shouldPoll` — so nothing waits a minute to be
 * seen. Push carries the urgent case to a phone that is not looking.
 */
export const POLL_INTERVAL_MS = 60_000;

/**
 * Whether a check is due: the tab is on screen and the last answer is at least
 * an interval old. Hidden tabs skip their turn rather than queueing it, so a
 * laptop opened after lunch asks once, not forty times.
 */
export function shouldPoll(visibility: DocumentVisibilityState, lastCheckedAt: number | null, now: number) {
  if (visibility !== "visible") return false;
  // A second of slack: the timer fires about an interval after the last check,
  // and «about» can be a few milliseconds short, which would skip a turn.
  return lastCheckedAt === null || now - lastCheckedAt >= POLL_INTERVAL_MS - 1_000;
}
