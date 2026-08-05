import {
  addLocalDays,
  compareLocalDates,
  formatLocalDate,
  localDateWeekday,
  MINUTES_PER_DAY,
  parseLocalDate,
  resolveLocal,
  toZonedParts,
  type LocalDate,
  type Weekday,
} from "@/domain/timezone";
import {
  contains,
  mergeIntervals,
  overlaps,
  padInterval,
  subtractIntervals,
  type Interval,
} from "@/domain/interval";

/**
 * The availability engine, roadmap section 7.3.
 *
 * Deterministic by construction: the same inputs give the same slots, and every
 * input is a value rather than a query. Nothing here reads a clock, a database
 * or a locale — the caller passes `now`, the rows and the settings, which is
 * what makes DST behaviour testable at all.
 *
 * The order of operations is the specification's own list, and it matters:
 *
 *   1. the weekly pattern in effect on that local date;
 *   2. plus one-off `available` exceptions, minus `unavailable` ones;
 *   3. minus what is already booked or held, each padded by the buffers;
 *   4. sliced on the grid step, keeping only starts whose whole service fits;
 *   5. minus anything inside the lead time or beyond the advance window.
 *
 * Slot starts are aligned to local midnight, not to the start of the shift. A
 * client reads 09:00, 09:15, 09:30; a shift that happens to begin at 09:07 does
 * not shift every published time in the day by seven minutes.
 */
export type ScheduleRuleInput = Readonly<{
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
  /** Local dates: `YYYY-MM-DD`, `effectiveTo` exclusive. */
  effectiveFrom: string;
  effectiveTo: string | null;
}>;

export type AvailabilityExceptionInput = Readonly<{
  kind: "available" | "unavailable";
  start: Date;
  end: Date;
}>;

export type AvailabilitySettings = Readonly<{
  slotStepMinutes: number;
  minLeadMinutes: number;
  maxAdvanceDays: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}>;

export type SlotSearch = Readonly<{
  date: LocalDate;
  timezone: string;
  durationMinutes: number;
  rules: readonly ScheduleRuleInput[];
  exceptions: readonly AvailabilityExceptionInput[];
  /** Existing bookings and active holds, as instants. */
  busy: readonly Interval[];
  settings: AvailabilitySettings;
  now: Date;
}>;

export type Slot = Readonly<{ start: Date; end: Date }>;

export const DEFAULT_SLOT_STEP_MINUTES = 15;

/** A rule applies on a date when the date falls inside its effective range. */
export function ruleAppliesOn(rule: ScheduleRuleInput, date: LocalDate) {
  if (localDateWeekday(date) !== rule.weekday) return false;

  const from = parseLocalDate(rule.effectiveFrom);
  if (!from || compareLocalDates(date, from) < 0) return false;

  if (rule.effectiveTo === null) return true;
  const to = parseLocalDate(rule.effectiveTo);
  // Exclusive, so a rule ending on the 10th does not apply on the 10th and the
  // rule that replaces it can start that same day without a gap or an overlap.
  return to !== null && compareLocalDates(date, to) < 0;
}

/**
 * The working intervals a weekly pattern produces on one local date.
 *
 * A local time that DST skipped cannot be worked, so a shift starting inside
 * the spring gap starts when the clock lands; a shift ending there ends at the
 * same instant. Both fall out of `resolveLocal` without a special case here.
 */
export function workingIntervalsFor(
  rules: readonly ScheduleRuleInput[],
  date: LocalDate,
  timezone: string,
): Interval[] {
  const intervals: Interval[] = [];

  for (const rule of rules) {
    if (!ruleAppliesOn(rule, date)) continue;

    const start = resolveLocal(date, rule.startMinute, timezone).instant;
    // 1440 is midnight at the end of the day, which is a time on the *next*
    // local date — resolving it against this one would land 24 hours early.
    const end =
      rule.endMinute >= MINUTES_PER_DAY
        ? resolveLocal(addLocalDays(date, 1), rule.endMinute - MINUTES_PER_DAY, timezone).instant
        : resolveLocal(date, rule.endMinute, timezone).instant;

    if (end.getTime() > start.getTime()) intervals.push({ start, end });
  }

  return mergeIntervals(intervals);
}

/**
 * Working time after the one-off exceptions.
 *
 * Extra availability is added first and blocks are removed second, so a day off
 * beats a "working late" entry that overlaps it. Between two conflicting
 * statements about the same hour, the one that keeps a client from booking is
 * the safe one to obey.
 */
export function applyExceptions(
  working: readonly Interval[],
  exceptions: readonly AvailabilityExceptionInput[],
): Interval[] {
  const extra = exceptions.filter((entry) => entry.kind === "available");
  const blocked = exceptions.filter((entry) => entry.kind === "unavailable");

  const widened = mergeIntervals([
    ...working,
    ...extra.map((entry) => ({ start: entry.start, end: entry.end })),
  ]);

  return subtractIntervals(
    widened,
    blocked.map((entry) => ({ start: entry.start, end: entry.end })),
  );
}

/**
 * Every slot a client may be offered on one local date for one specialist.
 *
 * Buffers are applied between appointments, not against the shift: a service
 * may end exactly at closing time, and the ten minutes of cleaning afterwards
 * are not a reason to refuse the last client of the day.
 */
export function generateSlots(search: SlotSearch): Slot[] {
  const { settings } = search;
  if (search.durationMinutes <= 0 || settings.slotStepMinutes <= 0) return [];

  const today = zonedToday(search.now, search.timezone);
  if (compareLocalDates(search.date, today) < 0) return [];
  if (compareLocalDates(search.date, addLocalDays(today, settings.maxAdvanceDays)) > 0) return [];

  const open = applyExceptions(
    workingIntervalsFor(search.rules, search.date, search.timezone),
    search.exceptions,
  );
  if (open.length === 0) return [];

  const blockedByOthers = search.busy.map((interval) =>
    padInterval(interval, settings.bufferBeforeMinutes, settings.bufferAfterMinutes),
  );
  const earliestStart = new Date(search.now.getTime() + settings.minLeadMinutes * 60_000);

  const slots: Slot[] = [];

  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += settings.slotStepMinutes) {
    const resolved = resolveLocal(search.date, minutes, search.timezone);
    // A local time DST skipped is a time no client can arrive at, and one that
    // happens twice would be an appointment nobody could identify. The first
    // is dropped; the second is offered once, at its first occurrence.
    if (resolved.kind === "gap") continue;

    const slot: Slot = {
      start: resolved.instant,
      end: new Date(resolved.instant.getTime() + search.durationMinutes * 60_000),
    };

    if (slot.start.getTime() < earliestStart.getTime()) continue;
    if (!open.some((interval) => contains(interval, slot))) continue;

    const padded = padInterval(slot, settings.bufferBeforeMinutes, settings.bufferAfterMinutes);
    if (blockedByOthers.some((interval) => overlaps(interval, padded))) continue;

    slots.push(slot);
  }

  return slots;
}

/** The local date it is in that timezone at this instant. */
export function zonedToday(now: Date, timezone: string): LocalDate {
  const { year, month, day } = toZonedParts(now, timezone);
  return { year, month, day };
}

/**
 * The next dates that have any slot at all, so a client sees "the soonest is
 * Thursday" instead of an empty calendar (section 7.8).
 */
export function findNextAvailableDates(
  search: Omit<SlotSearch, "date">,
  from: LocalDate,
  options: { limit?: number; horizonDays?: number } = {},
): { date: string; slots: Slot[] }[] {
  const limit = options.limit ?? 3;
  const horizon = Math.min(options.horizonDays ?? 30, search.settings.maxAdvanceDays + 1);
  const found: { date: string; slots: Slot[] }[] = [];

  for (let offset = 0; offset <= horizon && found.length < limit; offset += 1) {
    const date = addLocalDays(from, offset);
    const slots = generateSlots({ ...search, date });
    if (slots.length > 0) found.push({ date: formatLocalDate(date), slots });
  }

  return found;
}
