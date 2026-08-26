/**
 * Reading numbers, dates and durations out of spreadsheet cells, spec LOC-004
 * and LOC-007.
 *
 * Everything here parses through strings rather than `Number(raw)`. A price
 * list is money, and `parseFloat("240.55") * 100` is 24054.999999999996 — the
 * kind of error that shows up as a one-bani discrepancy weeks later, in a
 * product whose entire claim is that the arithmetic is trustworthy.
 */

export type NumberParts = Readonly<{ negative: boolean; integer: string; fraction: string }>;

/** Spaces Excel uses for thousands, plus the apostrophe some locales emit. */
const GROUPING = /[\s  ']/g;

/**
 * Splits a written number into sign, integer and fraction digits.
 *
 * The hard case is a single separator, where `1,200` is 1200 to an English
 * writer and 1.2 to a Russian one. The rule: with both separators present the
 * last one is the decimal point; with one, it is grouping only if what follows
 * is exactly three digits and the leading group looks like a real group — so
 * `1,200` reads as 1200 while `0,500` reads as 0.5, since no one writes a
 * thousands group as `0`.
 *
 * A cleaner answer exists — decide the convention once per column, since a
 * spreadsheet is internally consistent — and is worth doing if pilot files show
 * this guess failing. Until then the preview shows the parsed value, so a wrong
 * guess is visible before anything is written.
 */
export function parseNumberParts(raw: string): NumberParts | null {
  const trimmed = raw.trim().replace(GROUPING, "");
  if (trimmed === "") return null;

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  if (!/^[\d.,]+$/.test(unsigned)) return null;

  const lastComma = unsigned.lastIndexOf(",");
  const lastDot = unsigned.lastIndexOf(".");
  const separator = Math.max(lastComma, lastDot);

  if (separator === -1) {
    return /^\d+$/.test(unsigned) ? { negative, integer: unsigned, fraction: "" } : null;
  }

  const head = unsigned.slice(0, separator);
  const tail = unsigned.slice(separator + 1);
  if (!/^\d+$/.test(tail)) return null;

  const bothPresent = lastComma !== -1 && lastDot !== -1;
  const groupsThousands =
    !bothPresent && tail.length === 3 && /^[1-9]\d{0,2}$/.test(head.replace(/[.,]/g, ""));

  if (groupsThousands) {
    const digits = (head + tail).replace(/[.,]/g, "");
    return /^\d+$/.test(digits) ? { negative, integer: digits, fraction: "" } : null;
  }

  const integer = head.replace(/[.,]/g, "");
  if (integer !== "" && !/^\d+$/.test(integer)) return null;
  return { negative, integer: integer === "" ? "0" : integer, fraction: tail };
}

/**
 * Scales parsed digits to an integer at `scale` decimal places, rounding half
 * away from zero so that a loss rounds to the same magnitude as the equivalent
 * gain — the same rule `roundRatio` follows.
 */
export function scaleToInteger(parts: NumberParts, scale: number): number {
  const padded = parts.fraction.padEnd(scale, "0");
  const kept = padded.slice(0, scale);
  const roundUp = padded.length > scale && Number(padded[scale]) >= 5;

  const magnitude = Number(`${parts.integer}${kept}`) + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(magnitude)) return NaN;
  return parts.negative ? -magnitude : magnitude;
}

function parseScaled(raw: string, scale: number): number | null {
  const parts = parseNumberParts(raw);
  if (!parts) return null;
  const value = scaleToInteger(parts, scale);
  return Number.isSafeInteger(value) ? value : null;
}

/** "240,50" and "240.50" both become 24050 minor units. */
export function parseMoneyMinor(raw: string): number | null {
  return parseScaled(raw, 2);
}


export function parseIntegerValue(raw: string): number | null {
  const parts = parseNumberParts(raw);
  if (!parts || parts.fraction.replace(/0+$/, "") !== "") return null;
  const value = scaleToInteger(parts, 0);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Duration, accepting the several ways a salon writes it: `90`, `1:30`,
 * `1ч 30м`, `1h30`. Bare numbers are minutes, because a price list that says
 * `90` never means 90 hours.
 */
export function parseDurationMinutes(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;

  const clock = /^(\d+)\s*:\s*([0-5]\d)$/.exec(trimmed);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  const written = /^(?:(\d+)\s*(?:ч|h|ore|ora|час\w*)\s*)?(?:(\d+)\s*(?:м|мин\w*|m|min\w*)?)?$/.exec(
    trimmed,
  );
  if (written && (written[1] || written[2])) {
    const hours = Number(written[1] ?? 0);
    const minutes = Number(written[2] ?? 0);
    // `2ч` alone is two hours; `90` alone is ninety minutes.
    if (written[1] && !written[2]) return hours * 60;
    if (!written[1]) return minutes;
    return hours * 60 + minutes;
  }

  return parseIntegerValue(trimmed);
}

/**
 * A percentage as basis points: `40`, `40%` and `40,5%` become 4000 and 4050.
 */
export function parsePercentBasisPoints(raw: string): number | null {
  return parseScaled(raw.trim().replace(/%$/, ""), 2);
}

const DATE_FORMATS: readonly RegExp[] = [
  /^(?<day>\d{1,2})[.\-/](?<month>\d{1,2})[.\-/](?<year>\d{4})$/,
  /^(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2})$/,
];

/**
 * Dates in the `dd.MM.yyyy` of LOC-007, plus ISO.
 *
 * `new Date(raw)` is not an option: it reads `03/04/2026` as March 4th, while
 * every file this product will receive means April 3rd. A visit booked into the
 * wrong month lands in the wrong period on the dashboard.
 */
export function parseLocalDate(raw: string, time = "00:00"): Date | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const [datePart, timePart] = trimmed.split(/[\sT]+/, 2);

  for (const format of DATE_FORMATS) {
    const match = format.exec(datePart);
    if (!match?.groups) continue;

    const year = Number(match.groups.year);
    const month = Number(match.groups.month);
    const day = Number(match.groups.day);
    const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timePart ?? time);
    if (!clock) return null;

    const date = new Date(
      Date.UTC(year, month - 1, day, Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)),
    );
    // Rejects 31.02: Date.UTC would roll it forward into March rather than fail.
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }

  return null;
}

const TRUE_WORDS = new Set(["1", "да", "yes", "true", "y", "д", "da", "истина", "+"]);
const FALSE_WORDS = new Set(["0", "нет", "no", "false", "n", "н", "nu", "ложь", "-", ""]);

export function parseBoolean(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;
  return null;
}
