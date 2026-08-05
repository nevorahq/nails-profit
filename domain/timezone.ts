/**
 * Local time in an IANA timezone, and the two days a year it is not a function.
 *
 * Roadmap section 7.3: "Время хранится в UTC, правила графика — как local time
 * + IANA timezone. Переходы DST, неоднозначное и несуществующее локальное время
 * обрабатываются явно". A schedule says "Tuesdays, 09:00 to 18:00"; a booking
 * says "this instant". Converting between them is the whole of the availability
 * engine's correctness, and on two Sundays a year the conversion is not
 * one-to-one: an hour does not exist in spring and happens twice in autumn.
 *
 * Everything here goes through the runtime's own timezone database via `Intl`.
 * A hand-rolled offset table is wrong the moment a country moves its clocks —
 * which Moldova's neighbours have done twice in the last decade.
 */
export type LocalDate = Readonly<{ year: number; month: number; day: number }>;

export type ZonedParts = LocalDate &
  Readonly<{
    /** Minutes from local midnight, so arithmetic never touches a clock string. */
    minutes: number;
    /** ISO-8601: 1 is Monday, 7 is Sunday. */
    weekday: Weekday;
  }>;

export const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof weekdays)[number];

export const MINUTES_PER_DAY = 24 * 60;

export class UnknownTimezoneError extends Error {
  constructor(timezone: string) {
    super(`Unknown IANA timezone: ${timezone}`);
    this.name = "UnknownTimezoneError";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string) {
  const cached = formatters.get(timezone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
  } catch {
    throw new UnknownTimezoneError(timezone);
  }

  formatters.set(timezone, formatter);
  return formatter;
}

export function isSupportedTimezone(timezone: string): boolean {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_INDEX: Record<string, Weekday> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** The wall clock a person in that timezone reads at this instant. */
export function toZonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
    weekday: WEEKDAY_INDEX[value("weekday")],
  };
}

/** Minutes east of UTC at this instant; negative west of it. */
export function zoneOffsetMinutes(instant: Date, timezone: string): number {
  const local = toZonedParts(instant, timezone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, 0, local.minutes, 0, 0);
  // Seconds are dropped on both sides, so a comparison at second granularity
  // would drift; the instant is truncated to the same minute.
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return (asUtc - truncated) / 60_000;
}

export type LocalResolution =
  /** The ordinary case: exactly one instant answers to this wall time. */
  | Readonly<{ kind: "exact"; instant: Date }>
  /**
   * Spring forward. The wall time never happens; the clock jumps over it. The
   * instant offered is the moment the jump lands on, which is what a salon
   * means when it says "we open at 03:00" on the day 03:00 does not exist.
   */
  | Readonly<{ kind: "gap"; instant: Date }>
  /**
   * Autumn fall-back. The wall time happens twice. The first instant is the one
   * to use: a schedule that opens at 03:00 opens the first time it is 03:00,
   * and the second hour is extra availability, never a second opening.
   */
  | Readonly<{ kind: "ambiguous"; instant: Date; second: Date }>;

function instantFrom(date: LocalDate, minutes: number, offsetMinutes: number) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day, 0, minutes - offsetMinutes, 0, 0));
}

function readsAs(instant: Date, date: LocalDate, minutes: number, timezone: string) {
  const local = toZonedParts(instant, timezone);
  return (
    local.year === date.year &&
    local.month === date.month &&
    local.day === date.day &&
    local.minutes === minutes
  );
}

/**
 * Local wall time to an instant, with the two irregular cases named rather than
 * guessed at.
 *
 * The offset cannot be looked up before the instant is known and the instant
 * cannot be computed before the offset is: the way out is to guess with the
 * offset that applies near the target, then check what the candidate actually
 * reads as. A candidate that reads back correctly is right. Two different
 * candidates that both read back correctly mean the hour repeats. None means
 * the hour was skipped.
 */
export function resolveLocal(date: LocalDate, minutes: number, timezone: string): LocalResolution {
  const guess = new Date(Date.UTC(date.year, date.month - 1, date.day, 0, minutes, 0, 0));
  const beforeOffset = zoneOffsetMinutes(new Date(guess.getTime() - 12 * 3_600_000), timezone);
  const afterOffset = zoneOffsetMinutes(new Date(guess.getTime() + 12 * 3_600_000), timezone);

  const first = instantFrom(date, minutes, beforeOffset);
  const second = instantFrom(date, minutes, afterOffset);

  const firstValid = readsAs(first, date, minutes, timezone);
  const secondValid = readsAs(second, date, minutes, timezone);

  if (firstValid && secondValid) {
    return first.getTime() === second.getTime()
      ? { kind: "exact", instant: first }
      : {
          kind: "ambiguous",
          instant: first.getTime() < second.getTime() ? first : second,
          second: first.getTime() < second.getTime() ? second : first,
        };
  }

  if (firstValid) return { kind: "exact", instant: first };
  if (secondValid) return { kind: "exact", instant: second };

  // Neither reads back: the wall time was skipped. The clock jumped from
  // `beforeOffset` to `afterOffset`, and the instant that lands on is the one a
  // schedule should start at.
  return { kind: "gap", instant: instantFrom(date, minutes, beforeOffset) };
}

/** The instant a schedule means, taking the earlier of a repeated hour. */
export function localToUtc(date: LocalDate, minutes: number, timezone: string): Date {
  return resolveLocal(date, minutes, timezone).instant;
}

/** Calendar arithmetic on the local date alone, never on an instant. */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function localDateWeekday(date: LocalDate): Weekday {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  // getUTCDay is 0..6 from Sunday; ISO-8601 is 1..7 from Monday.
  return (day === 0 ? 7 : day) as Weekday;
}

export function compareLocalDates(left: LocalDate, right: LocalDate) {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.day - right.day;
}

/** `2026-08-05`, the form the API and the database both use for a local date. */
export function formatLocalDate(date: LocalDate) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function parseLocalDate(value: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };

  // Rejects 2026-02-30 rather than accepting the 2 March the calendar would
  // normalize it into: a date that silently moves is worse than an error.
  const normalized = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const survives =
    normalized.getUTCFullYear() === date.year &&
    normalized.getUTCMonth() + 1 === date.month &&
    normalized.getUTCDate() === date.day;

  return survives ? date : null;
}

/** `09:30` to 570. Minutes from midnight are what the engine actually adds. */
export function parseLocalTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatLocalTime(minutes: number) {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}
