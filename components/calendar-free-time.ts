/**
 * The hours the calendar can still sell, roadmap section 7.2.
 *
 * Kept out of the component because it is the part with rules rather than
 * markup, and rules deserve tests that do not need a renderer.
 */

/**
 * An instant, read as the wall clock of a location.
 *
 * `toISOString().slice(11, 16)` is the tempting version and it is wrong: it
 * shows UTC, which is two or three hours off in Chișinău and would offer a
 * client a time the studio is shut.
 */
export function clockAt(instant: string, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(instant));
}

export type ShiftRule = Readonly<{
  specialistId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** Local dates: a rota change takes effect on a day, not at an instant. */
  effectiveFrom: string;
  /** Exclusive, so a handover leaves no gap. */
  effectiveTo: string | null;
}>;

export type Span = Readonly<{ start: number; end: number }>;

/** Whether a rota rule covers this date. Mirrors `ruleAppliesOn` in `domain/availability`. */
function shiftCovers(rule: ShiftRule, localDate: string, weekday: number): boolean {
  if (rule.weekday !== weekday) return false;
  if (localDate < rule.effectiveFrom) return false;
  return rule.effectiveTo === null || localDate < rule.effectiveTo;
}

/** Overlapping spans read as one. Two rules for one morning are one morning. */
function merge(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end };
      continue;
    }
    merged.push({ ...span });
  }

  return merged;
}

/**
 * The hours a master could still sell today: their rota, less everything
 * already standing in it.
 *
 * Measured against the rota and against nothing else, which is the whole point.
 * Any fixed frame — the 08:00–20:00 the old timetable drew, or a whole calendar
 * day — would hand a master who works 10:00 to 16:00 far more free hours than
 * they have, and the studio would offer a client an hour nobody is in.
 *
 * `busy` arrives with the studio's buffers already added to each appointment.
 * A buffer is not free time — the booking engine will not place anything in it
 * — so leaving it out would offer the desk a ten-minute opening that the
 * product itself refuses to book.
 *
 * `minMinutes` is what separates a window from a crack. A gap shorter than the
 * shortest service on the price list cannot take a client whatever it looks
 * like, and counting it would make the tally over the day a number the studio
 * cannot act on.
 */
export function freeWindows(
  rota: readonly ShiftRule[],
  busy: readonly Span[],
  minMinutes: number,
): Span[] {
  const open = merge(rota.map((rule) => ({ start: rule.startMinute, end: rule.endMinute })));
  if (open.length === 0) return [];

  const taken = merge(busy);
  const free: Span[] = [];

  for (const shift of open) {
    let cursor = shift.start;

    for (const span of taken) {
      if (span.end <= cursor) continue;
      if (span.start >= shift.end) break;
      if (span.start > cursor) free.push({ start: cursor, end: Math.min(span.start, shift.end) });
      cursor = Math.max(cursor, span.end);
      if (cursor >= shift.end) break;
    }

    if (cursor < shift.end) free.push({ start: cursor, end: shift.end });
  }

  return free.filter((span) => span.end - span.start >= minMinutes);
}

/**
 * How long a set of spans lasts in total, overlaps counted once.
 *
 * Used for both halves of the tally: the rota a master works, and what is left
 * of it. Merging first is what keeps a split shift written as two overlapping
 * rules from being counted as more hours than there are in the morning.
 */
export function totalMinutes(spans: readonly Span[]): number {
  return merge(spans).reduce((sum, span) => sum + (span.end - span.start), 0);
}

/**
 * Hours, to the half, rounded down.
 *
 * Down because the remainder is not sellable: twenty minutes left at the end of
 * a shift is not half an hour of anything, and rounding it up would put a
 * figure over the day that promises the studio time it cannot fill. Halves
 * rather than whole hours because a 90-minute service leaves them constantly —
 * whole hours would report 6 for six and a half, every day, in one direction.
 */
export function toHalfHours(minutes: number): number {
  return Math.floor(minutes / 30) / 2;
}

/** The rota rules that apply to one specialist on one date. */
export function rotaFor(
  rules: readonly ShiftRule[],
  specialistId: string,
  localDate: string,
  weekday: number,
): ShiftRule[] {
  return rules.filter(
    (rule) => rule.specialistId === specialistId && shiftCovers(rule, localDate, weekday),
  );
}

/** An hour already spoken for, in minutes past midnight of the listed day. */
export type BusySpan = Readonly<{
  specialistId: string;
  /**
   * The one address it takes the hour from, or null for every address of this
   * master's. An appointment is null wherever it is — nobody is at two places
   * at once — and so is a block written for «все адреса»; only a block for a
   * single address names it.
   */
  locationId: string | null;
  span: Span;
}>;

/** One opening in one master's day, at the address their rota puts them at. */
export type FreeSlot = Readonly<{
  specialistId: string;
  locationId: string;
  start: number;
  end: number;
}>;

/**
 * The openings of a day, one per gap, as cards the list can draw between the
 * appointments.
 *
 * Per master *and per address*, not merged across either. Two masters each free
 * from 12:00 to 14:00 are two places a client can sit, and one master with the
 * same hours at two addresses has two answers to «куда записать», which is why
 * the slot carries its address: tapping it has to open the form on the right
 * one.
 *
 * The rota of an address is measured against everything the master has on the
 * day, wherever it is — an appointment at the other address takes the hour from
 * this one as well, which is the caller's `locationId: null` — but a block
 * written for one address takes it from that address alone.
 *
 * `notBefore` is per address, because «now» is a different wall-clock time at
 * each: it cuts the past off the front of a day that is today, and is 24 × 60
 * for a day that is over. What is left of a window shorter than `minMinutes`
 * is dropped like any other crack.
 */
export function freeSlotsOfDay(input: {
  shifts: readonly (ShiftRule & Readonly<{ locationId: string }>)[];
  /** Whose openings to draw, in the order they should be listed. */
  specialistIds: readonly string[];
  /** Only these addresses; null for every one the rota names. */
  locationId: string | null;
  date: string;
  weekday: number;
  busy: readonly BusySpan[];
  minMinutes: number;
  notBefore: (locationId: string) => number;
}): FreeSlot[] {
  const slots: FreeSlot[] = [];

  for (const specialistId of input.specialistIds) {
    const own = input.shifts.filter((rule) => rule.specialistId === specialistId);
    const places = new Set(
      own
        .filter((rule) => shiftCovers(rule, input.date, input.weekday))
        .map((rule) => rule.locationId)
        .filter((id) => input.locationId === null || id === input.locationId),
    );

    for (const locationId of places) {
      const rota = rotaFor(
        own.filter((rule) => rule.locationId === locationId),
        specialistId,
        input.date,
        input.weekday,
      );
      const taken: Span[] = input.busy
        .filter(
          (entry) =>
            entry.specialistId === specialistId &&
            (entry.locationId === null || entry.locationId === locationId),
        )
        .map((entry) => entry.span);

      const cutoff = input.notBefore(locationId);
      if (cutoff > 0) taken.push({ start: 0, end: cutoff });

      for (const window of freeWindows(rota, taken, input.minMinutes)) {
        slots.push({ specialistId, locationId, start: window.start, end: window.end });
      }
    }
  }

  return slots;
}

/**
 * Cuts each opening into slots of one step, from where the opening begins.
 *
 * The step is the address's own «Шаг слотов» — the setting the online booking
 * page is cut by — so the list and the public page offer the same number of
 * places for the same length of time. It is read per address because two
 * addresses of one studio may keep different steps.
 *
 * Counted from the start of the opening rather than from midnight. Online
 * booking lays its grid on the clock, which is right for a client choosing from
 * a page and wrong for a desk looking at a list: an opening from 09:40 would
 * lose its first twenty minutes to the grid, and the card would say 10:00 for a
 * time the master has been free since 09:40. What does not make a whole step is
 * not a slot — the tail of an opening shorter than one is dropped, not shown as
 * a short card nobody can book a step into.
 */
export function splitIntoSlots(
  openings: readonly FreeSlot[],
  stepOf: (locationId: string) => number,
): FreeSlot[] {
  const slots: FreeSlot[] = [];

  for (const opening of openings) {
    const step = stepOf(opening.locationId);
    // A step that is not a positive number cannot cut anything; the opening is
    // left whole rather than looping forever or vanishing.
    if (!(step > 0)) {
      slots.push(opening);
      continue;
    }
    for (let start = opening.start; start + step <= opening.end; start += step) {
      slots.push({ ...opening, start, end: start + step });
    }
  }

  return slots;
}
