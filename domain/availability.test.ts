import { describe, expect, test } from "vitest";

import {
  applyExceptions,
  findNextAvailableDates,
  generateSlots,
  ruleAppliesOn,
  workingIntervalsFor,
  type AvailabilitySettings,
  type ScheduleRuleInput,
  type SlotSearch,
} from "@/domain/availability";
import { toZonedParts, type LocalDate } from "@/domain/timezone";

const CHISINAU = "Europe/Chisinau";

/** 5 August 2026 is a Wednesday, ISO weekday 3. */
const WEDNESDAY: LocalDate = { year: 2026, month: 8, day: 5 };

const nineToSix: ScheduleRuleInput = {
  weekday: 3,
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};

const settings: AvailabilitySettings = {
  slotStepMinutes: 15,
  minLeadMinutes: 120,
  maxAdvanceDays: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
};

/** Wednesday 06:00 local, well before the shift starts. */
const NOW = new Date("2026-08-05T03:00:00Z");

function search(overrides: Partial<SlotSearch> = {}): SlotSearch {
  return {
    date: WEDNESDAY,
    timezone: CHISINAU,
    durationMinutes: 90,
    rules: [nineToSix],
    exceptions: [],
    busy: [],
    settings,
    now: NOW,
    ...overrides,
  };
}

/** Slot starts as the client reads them: "09:00", "09:15". */
function localStarts(slots: readonly { start: Date }[], timezone = CHISINAU) {
  return slots.map((slot) => {
    const parts = toZonedParts(slot.start, timezone);
    return `${String(Math.floor(parts.minutes / 60)).padStart(2, "0")}:${String(parts.minutes % 60).padStart(2, "0")}`;
  });
}

/** `findNextAvailableDates` supplies its own dates, so the search drops that field. */
function withoutDate(input: SlotSearch): Omit<SlotSearch, "date"> {
  const { date, ...rest } = input;
  void date;
  return rest;
}

describe("ruleAppliesOn", () => {
  test("matches the ISO weekday and nothing else", () => {
    expect(ruleAppliesOn(nineToSix, WEDNESDAY)).toBe(true);
    expect(ruleAppliesOn(nineToSix, { year: 2026, month: 8, day: 6 })).toBe(false);
  });

  test("the effective range is inclusive at the start and exclusive at the end", () => {
    const rule = { ...nineToSix, effectiveFrom: "2026-08-05", effectiveTo: "2026-08-12" };
    expect(ruleAppliesOn(rule, WEDNESDAY)).toBe(true);
    expect(ruleAppliesOn(rule, { year: 2026, month: 8, day: 12 })).toBe(false);
    expect(ruleAppliesOn(rule, { year: 2026, month: 7, day: 29 })).toBe(false);
  });

  test("a replacement rule starting the day the old one ends leaves no gap and no overlap", () => {
    const ending = { ...nineToSix, effectiveTo: "2026-08-05" };
    const starting = { ...nineToSix, effectiveFrom: "2026-08-05" };
    expect(ruleAppliesOn(ending, WEDNESDAY)).toBe(false);
    expect(ruleAppliesOn(starting, WEDNESDAY)).toBe(true);
  });

  test("a malformed effective date disables the rule rather than defaulting it on", () => {
    expect(ruleAppliesOn({ ...nineToSix, effectiveFrom: "05.08.2026" }, WEDNESDAY)).toBe(false);
  });
});

describe("workingIntervalsFor", () => {
  test("turns a local shift into instants in the right offset", () => {
    const [shift] = workingIntervalsFor([nineToSix], WEDNESDAY, CHISINAU);
    // August is UTC+3 in Moldova.
    expect(shift.start.toISOString()).toBe("2026-08-05T06:00:00.000Z");
    expect(shift.end.toISOString()).toBe("2026-08-05T15:00:00.000Z");
  });

  test("a split shift is two intervals, and abutting halves are one", () => {
    const morning = { ...nineToSix, endMinute: 13 * 60 };
    const evening = { ...nineToSix, startMinute: 15 * 60 };
    expect(workingIntervalsFor([morning, evening], WEDNESDAY, CHISINAU)).toHaveLength(2);

    const afternoon = { ...nineToSix, startMinute: 13 * 60 };
    expect(workingIntervalsFor([morning, afternoon], WEDNESDAY, CHISINAU)).toHaveLength(1);
  });

  test("a shift ending at midnight ends on the next local day, not 24 hours early", () => {
    const lateShift = { ...nineToSix, startMinute: 18 * 60, endMinute: 24 * 60 };
    const [shift] = workingIntervalsFor([lateShift], WEDNESDAY, CHISINAU);
    expect(shift.start.toISOString()).toBe("2026-08-05T15:00:00.000Z");
    expect(shift.end.toISOString()).toBe("2026-08-05T21:00:00.000Z");
  });

  test("a spring-forward day is an hour shorter in real time", () => {
    // 29 March 2026 is a Sunday, ISO weekday 7, and the clocks jump 03:00→04:00.
    const sundayShift: ScheduleRuleInput = {
      weekday: 7,
      startMinute: 2 * 60,
      endMinute: 10 * 60,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };
    const [shift] = workingIntervalsFor([sundayShift], { year: 2026, month: 3, day: 29 }, CHISINAU);
    // 02:00–10:00 on the clock is seven real hours, not eight.
    expect((shift.end.getTime() - shift.start.getTime()) / 3_600_000).toBe(7);
  });

  test("a fall-back day is an hour longer in real time", () => {
    const sundayShift: ScheduleRuleInput = {
      weekday: 7,
      startMinute: 2 * 60,
      endMinute: 10 * 60,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };
    const [shift] = workingIntervalsFor([sundayShift], { year: 2026, month: 10, day: 25 }, CHISINAU);
    expect((shift.end.getTime() - shift.start.getTime()) / 3_600_000).toBe(9);
  });

  test("no rule for that weekday means no working time", () => {
    expect(workingIntervalsFor([nineToSix], { year: 2026, month: 8, day: 6 }, CHISINAU)).toEqual([]);
  });
});

describe("applyExceptions", () => {
  const working = workingIntervalsFor([nineToSix], WEDNESDAY, CHISINAU);

  test("an unavailable block is cut out of the shift", () => {
    const result = applyExceptions(working, [
      {
        kind: "unavailable",
        start: new Date("2026-08-05T10:00:00Z"),
        end: new Date("2026-08-05T11:00:00Z"),
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].end.toISOString()).toBe("2026-08-05T10:00:00.000Z");
    expect(result[1].start.toISOString()).toBe("2026-08-05T11:00:00.000Z");
  });

  test("an available exception extends the day", () => {
    const [result] = applyExceptions(working, [
      {
        kind: "available",
        start: new Date("2026-08-05T15:00:00Z"),
        end: new Date("2026-08-05T17:00:00Z"),
      },
    ]);
    expect(result.end.toISOString()).toBe("2026-08-05T17:00:00.000Z");
  });

  test("a day off wins over an overlapping working-late entry", () => {
    // Two statements about the same hour: the one that prevents a booking is
    // the safe one to obey.
    const result = applyExceptions(working, [
      {
        kind: "available",
        start: new Date("2026-08-05T15:00:00Z"),
        end: new Date("2026-08-05T17:00:00Z"),
      },
      {
        kind: "unavailable",
        start: new Date("2026-08-05T06:00:00Z"),
        end: new Date("2026-08-05T18:00:00Z"),
      },
    ]);
    expect(result).toEqual([]);
  });
});

describe("generateSlots", () => {
  test("fills the shift on the grid and stops where the service no longer fits", () => {
    const slots = generateSlots(search());
    const times = localStarts(slots);

    expect(times[0]).toBe("09:00");
    expect(times[1]).toBe("09:15");
    // A 90-minute service starting at 16:30 ends at 18:00, exactly at closing.
    expect(times.at(-1)).toBe("16:30");
    expect(times).not.toContain("16:45");
  });

  test("starts are aligned to local midnight, not to the start of the shift", () => {
    const oddShift = { ...nineToSix, startMinute: 9 * 60 + 7 };
    const times = localStarts(generateSlots(search({ rules: [oddShift] })));
    // The shift begins at 09:07 and the first offered slot is still on the grid.
    expect(times[0]).toBe("09:15");
  });

  test("the step changes the grid", () => {
    const times = localStarts(
      generateSlots(search({ settings: { ...settings, slotStepMinutes: 30 } })),
    );
    expect(times.slice(0, 3)).toEqual(["09:00", "09:30", "10:00"]);
  });

  test("an existing booking blocks its own time and the buffer after it", () => {
    const times = localStarts(
      generateSlots(
        search({
          busy: [{ start: new Date("2026-08-05T07:00:00Z"), end: new Date("2026-08-05T08:30:00Z") }],
        }),
      ),
    );

    // The booking runs 10:00–11:30 local. A 90-minute service starting at 09:00
    // would run into it, so the morning is gone; with a ten minute buffer the
    // first start the day can still offer is 11:45.
    expect(times[0]).toBe("11:45");
    expect(times).not.toContain("09:00");
    expect(times).not.toContain("10:00");
    expect(times).not.toContain("11:30");
  });

  test("a buffer before is respected as well as a buffer after", () => {
    const times = localStarts(
      generateSlots(
        search({
          settings: { ...settings, bufferBeforeMinutes: 30, bufferAfterMinutes: 0 },
          busy: [{ start: new Date("2026-08-05T09:00:00Z"), end: new Date("2026-08-05T10:00:00Z") }],
        }),
      ),
    );
    // The booking runs 12:00–13:00 local. A slot at 10:00 ends at 11:30 and
    // clears it; one at 10:15 would end at 11:45, inside the half hour the
    // booking needs to prepare. The same buffer belongs to the slot itself, so
    // 13:00 — immediately after the booking — cannot be prepared for either.
    expect(times).toContain("10:00");
    expect(times).not.toContain("10:15");
    expect(times).not.toContain("13:00");
    expect(times).toContain("13:30");
  });

  test("the lead time hides slots that are too soon", () => {
    // 09:40 local on the same Wednesday, with a two hour lead.
    const times = localStarts(generateSlots(search({ now: new Date("2026-08-05T06:40:00Z") })));
    expect(times[0]).toBe("11:45");
  });

  test("a zero lead time offers the next slot on the grid", () => {
    const times = localStarts(
      generateSlots(
        search({ now: new Date("2026-08-05T06:40:00Z"), settings: { ...settings, minLeadMinutes: 0 } }),
      ),
    );
    expect(times[0]).toBe("09:45");
  });

  test("a date beyond the advance window has no slots", () => {
    const far = { year: 2026, month: 12, day: 30 };
    expect(generateSlots(search({ date: far }))).toEqual([]);
    expect(
      generateSlots(search({ date: far, settings: { ...settings, maxAdvanceDays: 365 } })).length,
    ).toBeGreaterThan(0);
  });

  test("a date in the past has no slots even when the weekday matches", () => {
    expect(generateSlots(search({ date: { year: 2026, month: 7, day: 29 } }))).toEqual([]);
  });

  test("a longer service yields fewer starts", () => {
    const short = generateSlots(search({ durationMinutes: 30 }));
    const long = generateSlots(search({ durationMinutes: 240 }));
    expect(short.length).toBeGreaterThan(long.length);
    expect(localStarts(long).at(-1)).toBe("14:00");
  });

  test("a service longer than the shift yields nothing", () => {
    expect(generateSlots(search({ durationMinutes: 10 * 60 }))).toEqual([]);
  });

  test("an invalid duration or step is refused rather than looping", () => {
    expect(generateSlots(search({ durationMinutes: 0 }))).toEqual([]);
    expect(generateSlots(search({ settings: { ...settings, slotStepMinutes: 0 } }))).toEqual([]);
  });

  test("slot ends are exactly the duration after the start", () => {
    const [slot] = generateSlots(search());
    expect((slot.end.getTime() - slot.start.getTime()) / 60_000).toBe(90);
  });

  test("the search is deterministic", () => {
    expect(generateSlots(search())).toEqual(generateSlots(search()));
  });

  test("local times skipped by DST are never offered", () => {
    // 29 March 2026, a Sunday: 03:00–03:59 does not exist in Moldova.
    const sundayShift: ScheduleRuleInput = {
      weekday: 7,
      startMinute: 0,
      endMinute: 12 * 60,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };
    const times = localStarts(
      generateSlots(
        search({
          date: { year: 2026, month: 3, day: 29 },
          rules: [sundayShift],
          durationMinutes: 30,
          now: new Date("2026-03-28T00:00:00Z"),
          settings: { ...settings, minLeadMinutes: 0 },
        }),
      ),
    );

    expect(times).toContain("02:30");
    expect(times).not.toContain("03:00");
    expect(times).not.toContain("03:30");
    expect(times).toContain("04:00");
  });

  test("a repeated local hour is offered once, at its first occurrence", () => {
    // 25 October 2026, a Sunday: 03:00–03:59 happens twice.
    const sundayShift: ScheduleRuleInput = {
      weekday: 7,
      startMinute: 0,
      endMinute: 12 * 60,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };
    const slots = generateSlots(
      search({
        date: { year: 2026, month: 10, day: 25 },
        rules: [sundayShift],
        durationMinutes: 30,
        now: new Date("2026-10-24T00:00:00Z"),
        settings: { ...settings, minLeadMinutes: 0 },
      }),
    );

    const threeOClock = slots.filter((slot) => localStarts([slot])[0] === "03:00");
    expect(threeOClock).toHaveLength(1);
    expect(threeOClock[0].start.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });

  test("an unavailable exception removes exactly its own hours", () => {
    const times = localStarts(
      generateSlots(
        search({
          durationMinutes: 60,
          exceptions: [
            {
              kind: "unavailable",
              start: new Date("2026-08-05T09:00:00Z"),
              end: new Date("2026-08-05T11:00:00Z"),
            },
          ],
        }),
      ),
    );

    // 12:00–14:00 local is blocked.
    expect(times).toContain("11:00");
    expect(times).not.toContain("11:15");
    expect(times).not.toContain("13:00");
    expect(times).toContain("14:00");
  });

  test("an available exception opens a day the weekly pattern does not cover", () => {
    const times = localStarts(
      generateSlots(
        search({
          date: { year: 2026, month: 8, day: 6 },
          durationMinutes: 60,
          exceptions: [
            {
              kind: "available",
              start: new Date("2026-08-06T07:00:00Z"),
              end: new Date("2026-08-06T09:00:00Z"),
            },
          ],
        }),
      ),
    );
    expect(times).toEqual(["10:00", "10:15", "10:30", "10:45", "11:00"]);
  });

  test("a fully booked day offers nothing", () => {
    expect(
      generateSlots(
        search({
          busy: [{ start: new Date("2026-08-05T05:00:00Z"), end: new Date("2026-08-05T16:00:00Z") }],
        }),
      ),
    ).toEqual([]);
  });

  test("a winter date uses the winter offset", () => {
    const wednesdayInJanuary = { year: 2026, month: 1, day: 7 };
    const [slot] = generateSlots(
      search({ date: wednesdayInJanuary, now: new Date("2026-01-07T00:00:00Z") }),
    );
    // 09:00 local at UTC+2.
    expect(slot.start.toISOString()).toBe("2026-01-07T07:00:00.000Z");
  });
});

describe("findNextAvailableDates", () => {
  test("skips days with no availability and stops at the limit", () => {
    const rest = withoutDate(search());
    const found = findNextAvailableDates(rest, WEDNESDAY, { limit: 2 });

    // Only Wednesdays are worked, so the next two are a week apart.
    expect(found.map((entry) => entry.date)).toEqual(["2026-08-05", "2026-08-12"]);
    expect(found[0].slots.length).toBeGreaterThan(0);
  });

  test("returns nothing when the horizon holds no working day", () => {
    const rest = withoutDate(search({ rules: [] }));
    expect(findNextAvailableDates(rest, WEDNESDAY, { limit: 3 })).toEqual([]);
  });

  test("never looks past the advance window", () => {
    const rest = withoutDate(search({ settings: { ...settings, maxAdvanceDays: 3 } }));
    expect(findNextAvailableDates(rest, WEDNESDAY, { limit: 3, horizonDays: 60 })).toHaveLength(1);
  });
});
