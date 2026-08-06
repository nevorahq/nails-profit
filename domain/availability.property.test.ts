import { describe, expect, it } from "vitest";

import {
  applyExceptions,
  findNextAvailableDates,
  generateSlots,
  workingIntervalsFor,
  type AvailabilityExceptionInput,
  type ScheduleRuleInput,
  type Slot,
  type SlotSearch,
} from "@/domain/availability";
import { contains, overlaps, padInterval, type Interval } from "@/domain/interval";
import {
  addLocalDays,
  formatLocalDate,
  localDateWeekday,
  MINUTES_PER_DAY,
  resolveLocal,
  toZonedParts,
  type LocalDate,
  type Weekday,
} from "@/domain/timezone";

/**
 * The property half of roadmap section 7.12's "Unit/property" row.
 *
 * `availability.test.ts` states what the engine does on cases a person chose:
 * a shift starting at 09:07, the Sunday the clocks jump, a buffer that eats the
 * last slot of the day. Those are the cases somebody thought of. The engine's
 * input is five independent dimensions — a weekly pattern, one-off exceptions,
 * what is already booked, five settings and a timezone — and the interesting
 * failures live where two of them meet: a rule that ends at midnight on the day
 * the clocks go back, a buffer wider than the gap an exception left.
 *
 * So this states the rules the engine must obey for *any* input and checks them
 * against generated ones. The generator is a seeded arithmetic sequence rather
 * than a library: a failure has to be reproducible from the file itself, the
 * repository does not take a dependency for a hundred lines, and the seed in
 * the message is the whole reproduction.
 *
 * The monotonicity properties are the ones worth reading twice. "A bigger
 * buffer never adds a slot" sounds too obvious to test, and it is exactly the
 * shape of a sign error: subtract where you meant to add and the engine offers
 * *more* as the studio asks for more room. No single example makes that
 * visible, because each individual answer still looks plausible.
 */
const TIMEZONES = [
  // Where the pilot is, and the DST rules the tests are anchored on.
  "Europe/Chisinau",
  // A different transition date and a zone that sits on UTC half the year.
  "Europe/London",
  // No transitions at all: the engine must not need one.
  "Asia/Tbilisi",
  // Thirty-minute DST, which breaks anything that assumes an hourly offset.
  "Australia/Lord_Howe",
  "UTC",
];

/**
 * Instants near a transition, so the awkward days are not left to chance: one
 * scenario in three starts within a day of a clock change.
 */
const ANCHORS = [
  "2026-03-29T00:30:00Z", // Europe springs forward
  "2026-10-25T00:30:00Z", // Europe falls back
  "2026-04-05T14:00:00Z", // Lord Howe falls back
  "2026-08-05T09:00:00Z",
  "2026-01-14T22:00:00Z",
  "2026-11-30T06:00:00Z",
];

const STEPS = [5, 10, 15, 20, 30, 60];
const LEADS = [0, 15, 60, 240, 1_440];
const ADVANCES = [0, 1, 7, 30, 90];
const BUFFERS = [0, 5, 10, 15, 30];
const DURATIONS = [15, 30, 45, 60, 90, 120];

/** Deterministic, self-contained, and good enough to spread over the space. */
function randomFrom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Scenario = SlotSearch & { seed: number };

function buildScenario(seed: number): Scenario {
  const random = randomFrom(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

  const timezone = pick(TIMEZONES);
  const now = new Date(pick(ANCHORS));
  const today = toZonedParts(now, timezone);
  const anchor: LocalDate = { year: today.year, month: today.month, day: today.day };

  const settings = {
    slotStepMinutes: pick(STEPS),
    minLeadMinutes: pick(LEADS),
    maxAdvanceDays: pick(ADVANCES),
    bufferBeforeMinutes: pick(BUFFERS),
    bufferAfterMinutes: pick(BUFFERS),
  };

  // Past dates and dates past the horizon are generated on purpose: refusing
  // them is part of the contract, not a case to keep out of the sample.
  const date = addLocalDays(anchor, between(-1, Math.min(settings.maxAdvanceDays + 2, 20)));

  const rules: ScheduleRuleInput[] = [];
  for (let index = 0; index < between(1, 3); index += 1) {
    const startMinute = between(0, 22 * 60) - (between(0, 22 * 60) % 5);
    rules.push({
      weekday: between(1, 7) as Weekday,
      startMinute,
      // 1440 is midnight at the end of the day, and a shift that runs to it is
      // the case the engine has a branch for.
      endMinute: Math.min(MINUTES_PER_DAY, startMinute + between(1, 16) * 60),
      effectiveFrom: formatLocalDate(addLocalDays(anchor, -between(0, 400))),
      effectiveTo: random() < 0.3 ? formatLocalDate(addLocalDays(anchor, between(1, 60))) : null,
    });
  }

  const dayStart = Date.UTC(date.year, date.month - 1, date.day) - 12 * 3_600_000;
  const spanMinutes = () => between(0, 36 * 60);

  const exceptions: AvailabilityExceptionInput[] = [];
  for (let index = 0; index < between(0, 3); index += 1) {
    const start = dayStart + spanMinutes() * 60_000;
    exceptions.push({
      kind: random() < 0.5 ? "available" : "unavailable",
      start: new Date(start),
      end: new Date(start + between(15, 8 * 60) * 60_000),
    });
  }

  const busy: Interval[] = [];
  for (let index = 0; index < between(0, 4); index += 1) {
    const start = dayStart + spanMinutes() * 60_000;
    busy.push({ start: new Date(start), end: new Date(start + between(15, 240) * 60_000) });
  }

  return {
    seed,
    date,
    timezone,
    durationMinutes: pick(DURATIONS),
    rules,
    exceptions,
    busy,
    settings,
    now,
  };
}

/**
 * The days the random sample cannot be trusted to reach.
 *
 * A shift has to be open across the exact hour a clock moves for the awkward
 * case to happen at all, and three hundred random scenarios turned out never to
 * arrange that: removing the engine's skip of non-existent local times left
 * every property passing. So the transitions are constructed — a specialist
 * working the whole day, nothing booked, no lead time — and the properties
 * below run over them alongside the generated ones.
 */
const TRANSITIONS: readonly { timezone: string; date: LocalDate }[] = [
  { timezone: "Europe/Chisinau", date: { year: 2026, month: 3, day: 29 } },
  { timezone: "Europe/Chisinau", date: { year: 2026, month: 10, day: 25 } },
  { timezone: "Europe/London", date: { year: 2026, month: 3, day: 29 } },
  { timezone: "Europe/London", date: { year: 2026, month: 10, day: 25 } },
  // Thirty minutes rather than an hour, and it lands on a half-past.
  { timezone: "Australia/Lord_Howe", date: { year: 2026, month: 4, day: 5 } },
  { timezone: "Australia/Lord_Howe", date: { year: 2026, month: 10, day: 4 } },
  // Controls: whatever the transitions do, these days must behave normally.
  { timezone: "Asia/Tbilisi", date: { year: 2026, month: 3, day: 29 } },
  { timezone: "UTC", date: { year: 2026, month: 10, day: 25 } },
];

function transitionScenario(
  timezone: string,
  date: LocalDate,
  slotStepMinutes: number,
  seed: number,
): Scenario {
  const dayBefore = addLocalDays(date, -1);

  return {
    seed,
    date,
    timezone,
    durationMinutes: 30,
    rules: [
      {
        weekday: localDateWeekday(date),
        startMinute: 0,
        endMinute: MINUTES_PER_DAY,
        effectiveFrom: formatLocalDate(addLocalDays(date, -30)),
        effectiveTo: null,
      },
    ],
    exceptions: [],
    busy: [],
    settings: {
      slotStepMinutes,
      minLeadMinutes: 0,
      maxAdvanceDays: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    },
    now: new Date(Date.UTC(dayBefore.year, dayBefore.month - 1, dayBefore.day, 12)),
  };
}

const RUNS = 300;
const scenarios = [
  ...Array.from({ length: RUNS }, (_, index) => buildScenario(index * 2_654_435_761)),
  ...TRANSITIONS.flatMap((transition, index) =>
    [15, 30, 60].map((step, offset) =>
      transitionScenario(transition.timezone, transition.date, step, -(index * 10 + offset + 1)),
    ),
  ),
];

/** A failing case has to be readable and re-runnable from what the test prints. */
function label(scenario: Scenario) {
  return `seed ${scenario.seed}: ${JSON.stringify({
    date: formatLocalDate(scenario.date),
    timezone: scenario.timezone,
    duration: scenario.durationMinutes,
    settings: scenario.settings,
    now: scenario.now.toISOString(),
    rules: scenario.rules,
    exceptions: scenario.exceptions.map((entry) => ({
      kind: entry.kind,
      start: entry.start.toISOString(),
      end: entry.end.toISOString(),
    })),
    busy: scenario.busy.map((entry) => ({
      start: entry.start.toISOString(),
      end: entry.end.toISOString(),
    })),
  })}`;
}

function starts(slots: readonly Slot[]) {
  return slots.map((slot) => slot.start.getTime());
}

/** Every property below is checked on the same sample. */
function forEach(check: (scenario: Scenario, slots: Slot[]) => void) {
  for (const scenario of scenarios) check(scenario, generateSlots(scenario));
}

describe("the availability engine, on generated input", () => {
  it("offers something at least sometimes", () => {
    // Without this the whole file passes on a sample that is empty everywhere,
    // which is the failure mode of every generator that ever drifted.
    const productive = scenarios.filter((scenario) => generateSlots(scenario).length > 0);
    expect(productive.length).toBeGreaterThan(RUNS / 10);
  });

  it("only offers time the specialist is actually open for", () => {
    forEach((scenario, slots) => {
      const open = applyExceptions(
        workingIntervalsFor(scenario.rules, scenario.date, scenario.timezone),
        scenario.exceptions,
      );
      for (const slot of slots) {
        expect(
          open.some((interval) => contains(interval, slot)),
          label(scenario),
        ).toBe(true);
      }
    });
  });

  it("never offers a slot inside the lead time", () => {
    forEach((scenario, slots) => {
      const earliest = scenario.now.getTime() + scenario.settings.minLeadMinutes * 60_000;
      for (const slot of slots) {
        expect(slot.start.getTime(), label(scenario)).toBeGreaterThanOrEqual(earliest);
      }
    });
  });

  it("never offers a slot that collides with an appointment, buffers included", () => {
    forEach((scenario, slots) => {
      const { bufferBeforeMinutes, bufferAfterMinutes } = scenario.settings;
      for (const slot of slots) {
        const padded = padInterval(slot, bufferBeforeMinutes, bufferAfterMinutes);
        for (const taken of scenario.busy) {
          expect(
            overlaps(padInterval(taken, bufferBeforeMinutes, bufferAfterMinutes), padded),
            label(scenario),
          ).toBe(false);
        }
      }
    });
  });

  it("puts every slot on the local grid, on the day that was asked for", () => {
    forEach((scenario, slots) => {
      for (const slot of slots) {
        const local = toZonedParts(slot.start, scenario.timezone);
        expect({ y: local.year, m: local.month, d: local.day }, label(scenario)).toEqual({
          y: scenario.date.year,
          m: scenario.date.month,
          d: scenario.date.day,
        });
        expect(local.minutes % scenario.settings.slotStepMinutes, label(scenario)).toBe(0);

        // The local time a client reads leads back to the instant offered. On
        // the day an hour repeats this is the property that says which of the
        // two the studio meant, and it is the first thing to break if the
        // engine ever starts working in UTC minutes.
        const resolved = resolveLocal(scenario.date, local.minutes, scenario.timezone);
        expect(resolved.kind, label(scenario)).not.toBe("gap");
        expect(resolved.instant.getTime(), label(scenario)).toBe(slot.start.getTime());
      }
    });
  });

  it("returns slots in order, without repeating one", () => {
    forEach((scenario, slots) => {
      const times = starts(slots);
      expect(new Set(times).size, label(scenario)).toBe(times.length);
      expect([...times].sort((left, right) => left - right), label(scenario)).toEqual(times);
    });
  });

  it("gives the same answer twice", () => {
    forEach((scenario, slots) => {
      expect(starts(generateSlots(scenario)), label(scenario)).toEqual(starts(slots));
    });
  });

  it("never gains a slot when a buffer, the service or the lead time grows", () => {
    forEach((scenario, slots) => {
      const offered = new Set(starts(slots));
      const widerBuffers = generateSlots({
        ...scenario,
        settings: {
          ...scenario.settings,
          bufferBeforeMinutes: scenario.settings.bufferBeforeMinutes + 15,
          bufferAfterMinutes: scenario.settings.bufferAfterMinutes + 15,
        },
      });
      const longerService = generateSlots({
        ...scenario,
        durationMinutes: scenario.durationMinutes + 30,
      });
      const laterLead = generateSlots({
        ...scenario,
        settings: { ...scenario.settings, minLeadMinutes: scenario.settings.minLeadMinutes + 30 },
      });

      for (const slots of [widerBuffers, longerService, laterLead]) {
        for (const time of starts(slots)) {
          expect(offered.has(time), label(scenario)).toBe(true);
        }
      }
    });
  });

  it("never gains a slot when something else is booked", () => {
    forEach((scenario, slots) => {
      const offered = new Set(starts(slots));
      const extra = scenario.busy.at(0) ?? {
        start: scenario.now,
        end: new Date(scenario.now.getTime() + 3_600_000),
      };
      const busier = generateSlots({
        ...scenario,
        busy: [
          ...scenario.busy,
          { start: extra.start, end: new Date(extra.start.getTime() + 45 * 60_000) },
        ],
      });

      for (const time of starts(busier)) expect(offered.has(time), label(scenario)).toBe(true);
    });
  });

  it("offers nothing on a day that is blocked end to end", () => {
    forEach((scenario) => {
      const dayOff = generateSlots({
        ...scenario,
        exceptions: [
          ...scenario.exceptions,
          {
            kind: "unavailable",
            start: new Date(Date.UTC(scenario.date.year, scenario.date.month - 1, scenario.date.day) - 2 * 86_400_000),
            end: new Date(Date.UTC(scenario.date.year, scenario.date.month - 1, scenario.date.day) + 2 * 86_400_000),
          },
        ],
      });

      expect(dayOff, label(scenario)).toEqual([]);
    });
  });

  it("refuses dates outside the window it published", () => {
    forEach((scenario) => {
      const today = toZonedParts(scenario.now, scenario.timezone);
      const anchor: LocalDate = { year: today.year, month: today.month, day: today.day };

      expect(
        generateSlots({ ...scenario, date: addLocalDays(anchor, -1) }),
        label(scenario),
      ).toEqual([]);
      expect(
        generateSlots({
          ...scenario,
          date: addLocalDays(anchor, scenario.settings.maxAdvanceDays + 1),
        }),
        label(scenario),
      ).toEqual([]);
    });
  });

  it("only ever suggests dates that really have room", () => {
    // Section 7.8 shows the soonest dates instead of an empty calendar, and the
    // one thing that promise cannot survive is suggesting a day with nothing on
    // it.
    for (const scenario of scenarios) {
      const today = toZonedParts(scenario.now, scenario.timezone);
      const found = findNextAvailableDates(
        scenario,
        { year: today.year, month: today.month, day: today.day },
        { limit: 3, horizonDays: 14 },
      );

      expect(found.length, label(scenario)).toBeLessThanOrEqual(3);
      for (const day of found) expect(day.slots.length, label(scenario)).toBeGreaterThan(0);
      expect([...found].map((day) => day.date).sort(), label(scenario)).toEqual(
        found.map((day) => day.date),
      );
    }
  });
});
