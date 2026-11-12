import { describe, expect, test } from "vitest";

import { clockAt, freeSlotsOfDay, freeWindows, rotaFor, splitIntoSlots, toHalfHours, totalMinutes } from "@/components/calendar-free-time";

describe("reading an instant at a location", () => {
  test("summer and winter are different offsets in the same zone", () => {
    // 06:00 UTC is 09:00 in Chișinău in August and 08:00 in January, and a
    // studio told the wrong one turns clients away at an open door.
    expect(clockAt("2026-08-05T06:00:00.000Z", "Europe/Chisinau")).toBe("09:00");
    expect(clockAt("2026-01-05T06:00:00.000Z", "Europe/Chisinau")).toBe("08:00");
  });

  test("midnight stays 00:00 rather than becoming 24:00", () => {
    expect(clockAt("2026-08-04T21:00:00.000Z", "Europe/Chisinau")).toBe("00:00");
  });

  test("the same instant reads differently in two of a studio's addresses", () => {
    const instant = "2026-08-05T06:00:00.000Z";
    expect(clockAt(instant, "Europe/Chisinau")).toBe("09:00");
    expect(clockAt(instant, "Europe/Lisbon")).toBe("07:00");
  });
});

describe("what a master could still sell today", () => {
  const shift = (start: number, end: number) => ({
    specialistId: "anna",
    weekday: 4,
    startMinute: start,
    endMinute: end,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  });

  /**
   * The bug this exists to prevent: the grid is 08:00–20:00 for everybody, so
   * measuring emptiness against it would hand a master who works 10:00–16:00
   * eleven free hours and paint their morning yellow.
   */
  test("measures against the rota, not against the grid", () => {
    const free = freeWindows([shift(600, 960)], [], 30);

    expect(free).toEqual([{ start: 600, end: 960 }]);
  });

  test("splits the shift around what is already in it", () => {
    // Booked 11:00–12:00, so the morning and the afternoon are two windows.
    const free = freeWindows([shift(600, 960)], [{ start: 660, end: 720 }], 30);

    expect(free).toEqual([
      { start: 600, end: 660 },
      { start: 720, end: 960 },
    ]);
  });

  /**
   * A gap shorter than the shortest service cannot take a client whatever it
   * looks like. Counting one would put a number in the column head that the
   * studio cannot act on.
   */
  test("does not call a crack a window", () => {
    const free = freeWindows(
      [shift(600, 960)],
      [
        { start: 600, end: 700 },
        // 20 minutes, against a 30-minute floor.
        { start: 720, end: 960 },
      ],
      30,
    );

    expect(free).toEqual([]);
  });

  test("counts a gap that is exactly long enough", () => {
    const free = freeWindows(
      [shift(600, 960)],
      [
        { start: 600, end: 700 },
        { start: 730, end: 960 },
      ],
      30,
    );

    expect(free).toEqual([{ start: 700, end: 730 }]);
  });

  test("reads two rules for one morning as one morning", () => {
    // A split shift written twice, overlapping: 10:00–14:00 and 13:00–16:00.
    const free = freeWindows([shift(600, 840), shift(780, 960)], [], 30);

    expect(free).toEqual([{ start: 600, end: 960 }]);
  });

  test("keeps a real split shift apart", () => {
    // Morning and evening with a genuine break between them.
    const free = freeWindows([shift(600, 720), shift(840, 960)], [], 30);

    expect(free).toEqual([
      { start: 600, end: 720 },
      { start: 840, end: 960 },
    ]);
  });

  test("counts overlapping busy spans once", () => {
    // A blocked interval sitting over an appointment: still one occupied run.
    const free = freeWindows(
      [shift(600, 960)],
      [
        { start: 660, end: 780 },
        { start: 700, end: 720 },
      ],
      30,
    );

    expect(free).toEqual([
      { start: 600, end: 660 },
      { start: 780, end: 960 },
    ]);
  });

  test("ignores anything outside the shift", () => {
    // An appointment before the master starts does not eat into their day.
    const free = freeWindows([shift(600, 960)], [{ start: 480, end: 540 }], 30);

    expect(free).toEqual([{ start: 600, end: 960 }]);
  });

  test("has nothing free on a day off", () => {
    expect(freeWindows([], [{ start: 660, end: 720 }], 30)).toEqual([]);
  });

  test("has nothing free when the day is fully booked", () => {
    expect(freeWindows([shift(600, 960)], [{ start: 540, end: 1020 }], 30)).toEqual([]);
  });
});

describe("which rota rules apply on a date", () => {
  const rule = (over: Partial<Parameters<typeof rotaFor>[0][number]> = {}) => ({
    specialistId: "anna",
    weekday: 4,
    startMinute: 600,
    endMinute: 960,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...over,
  });

  test("takes the rule for this weekday and nobody else's", () => {
    const rules = [rule(), rule({ weekday: 5 }), rule({ specialistId: "irina" })];

    expect(rotaFor(rules, "anna", "2026-09-10", 4)).toHaveLength(1);
  });

  test("ignores a rule that has not started yet", () => {
    expect(rotaFor([rule({ effectiveFrom: "2026-10-01" })], "anna", "2026-09-10", 4)).toEqual([]);
  });

  /** `effective_to` is exclusive, so a handover leaves no gap and no overlap. */
  test("drops a rule on the day its replacement takes over", () => {
    expect(rotaFor([rule({ effectiveTo: "2026-09-10" })], "anna", "2026-09-10", 4)).toEqual([]);
    expect(rotaFor([rule({ effectiveTo: "2026-09-11" })], "anna", "2026-09-10", 4)).toHaveLength(1);
  });
});

describe("adding up a day", () => {
  test("counts overlapping spans once", () => {
    // A split shift written as two overlapping rules is one stretch of time,
    // not the sum of both — which would report more hours than the day has.
    expect(totalMinutes([{ start: 600, end: 840 }, { start: 780, end: 960 }])).toBe(360);
  });

  test("adds spans that do not touch", () => {
    expect(totalMinutes([{ start: 600, end: 720 }, { start: 840, end: 960 }])).toBe(240);
  });

  test("is nothing when there is nothing", () => {
    expect(totalMinutes([])).toBe(0);
  });

  /**
   * Down, always. Twenty minutes at the end of a shift is not half an hour of
   * anything, and rounding it up would put time in the column head that the
   * studio cannot sell.
   */
  test.each([
    [600, 10],
    [630, 10.5],
    [620, 10],
    [655, 10.5],
    [29, 0],
    [30, 0.5],
  ])("reads %i minutes as %s hours", (minutes, hours) => {
    expect(toHalfHours(minutes)).toBe(hours);
  });
});

describe("the openings of a day, as cards", () => {
  const rule = (specialistId: string, locationId: string, start: number, end: number) => ({
    specialistId,
    locationId,
    weekday: 4,
    startMinute: start,
    endMinute: end,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  });
  const base = {
    date: "2026-08-06",
    weekday: 4,
    minMinutes: 30,
    locationId: null,
    notBefore: () => 0,
  };

  test("a gap between two appointments is one card, at both ends of the day", () => {
    const slots = freeSlotsOfDay({
      ...base,
      shifts: [rule("anna", "salon", 600, 1080)],
      specialistIds: ["anna"],
      busy: [
        { specialistId: "anna", locationId: "salon", span: { start: 660, end: 720 } },
        { specialistId: "anna", locationId: "salon", span: { start: 840, end: 900 } },
      ],
    });
    expect(slots).toEqual([
      { specialistId: "anna", locationId: "salon", start: 600, end: 660 },
      { specialistId: "anna", locationId: "salon", start: 720, end: 840 },
      { specialistId: "anna", locationId: "salon", start: 900, end: 1080 },
    ]);
  });

  test("two masters free at the same hour are two cards, not one", () => {
    const slots = freeSlotsOfDay({
      ...base,
      shifts: [rule("anna", "salon", 720, 840), rule("maria", "salon", 720, 840)],
      specialistIds: ["anna", "maria"],
      busy: [],
    });
    expect(slots.map((slot) => slot.specialistId)).toEqual(["anna", "maria"]);
  });

  test("a master at two addresses has a card at each, naming where", () => {
    const slots = freeSlotsOfDay({
      ...base,
      shifts: [rule("anna", "salon", 600, 720), rule("anna", "home", 780, 900)],
      specialistIds: ["anna"],
      busy: [],
    });
    expect(slots.map((slot) => [slot.locationId, slot.start])).toEqual([
      ["salon", 600],
      ["home", 780],
    ]);
  });

  test("an appointment, wherever it is, takes the hour from every address of that master", () => {
    const slots = freeSlotsOfDay({
      ...base,
      shifts: [rule("anna", "salon", 600, 720)],
      specialistIds: ["anna"],
      busy: [{ specialistId: "anna", locationId: null, span: { start: 600, end: 660 } }],
    });
    expect(slots).toEqual([{ specialistId: "anna", locationId: "salon", start: 660, end: 720 }]);
  });

  test("a block for one address leaves the other alone, and a block for all takes both", () => {
    const shifts = [rule("anna", "salon", 600, 720), rule("anna", "home", 600, 720)];
    const one = freeSlotsOfDay({
      ...base,
      shifts,
      specialistIds: ["anna"],
      busy: [{ specialistId: "anna", locationId: "salon", span: { start: 600, end: 720 } }],
    });
    expect(one.map((slot) => slot.locationId)).toEqual(["home"]);

    const all = freeSlotsOfDay({
      ...base,
      shifts,
      specialistIds: ["anna"],
      busy: [{ specialistId: "anna", locationId: null, span: { start: 600, end: 720 } }],
    });
    expect(all).toEqual([]);
  });

  test("somebody else's appointment is not this master's busy hour", () => {
    const slots = freeSlotsOfDay({
      ...base,
      shifts: [rule("anna", "salon", 600, 720)],
      specialistIds: ["anna"],
      busy: [{ specialistId: "maria", locationId: "salon", span: { start: 600, end: 720 } }],
    });
    expect(slots).toHaveLength(1);
  });

  test("only the listed masters and, when asked, only the chosen address", () => {
    const shifts = [rule("anna", "salon", 600, 720), rule("anna", "home", 780, 900), rule("maria", "salon", 600, 720)];
    expect(freeSlotsOfDay({ ...base, shifts, specialistIds: ["maria"], busy: [] })).toHaveLength(1);
    const there = freeSlotsOfDay({ ...base, shifts, specialistIds: ["anna"], locationId: "home", busy: [] });
    expect(there.map((slot) => slot.locationId)).toEqual(["home"]);
  });

  test("a day the master does not work has no cards", () => {
    const slots = freeSlotsOfDay({
      ...base,
      weekday: 5,
      shifts: [rule("anna", "salon", 600, 720)],
      specialistIds: ["anna"],
      busy: [],
    });
    expect(slots).toEqual([]);
  });

  test("a rota not yet in force, or already over, offers nothing", () => {
    const future = { ...rule("anna", "salon", 600, 720), effectiveFrom: "2026-09-01" };
    const over = { ...rule("anna", "salon", 600, 720), effectiveTo: "2026-08-06" };
    for (const shifts of [[future], [over]]) {
      expect(freeSlotsOfDay({ ...base, shifts, specialistIds: ["anna"], busy: [] })).toEqual([]);
    }
  });

  test("a gap shorter than the shortest service is not a card", () => {
    const slots = freeSlotsOfDay({
      ...base,
      shifts: [rule("anna", "salon", 600, 720)],
      specialistIds: ["anna"],
      busy: [{ specialistId: "anna", locationId: "salon", span: { start: 620, end: 720 } }],
    });
    expect(slots).toEqual([]);
  });

  test("the past is cut off the front of today, and a day that is over has no cards", () => {
    const shifts = [rule("anna", "salon", 600, 1080)];
    const midday = freeSlotsOfDay({
      ...base,
      shifts,
      specialistIds: ["anna"],
      busy: [],
      notBefore: () => 750,
    });
    expect(midday).toEqual([{ specialistId: "anna", locationId: "salon", start: 750, end: 1080 }]);

    const over = freeSlotsOfDay({ ...base, shifts, specialistIds: ["anna"], busy: [], notBefore: () => 24 * 60 });
    expect(over).toEqual([]);
  });

  test("now is read at each address, so one address can be over while another is open", () => {
    const shifts = [rule("anna", "salon", 600, 720), rule("anna", "home", 600, 720)];
    const slots = freeSlotsOfDay({
      ...base,
      shifts,
      specialistIds: ["anna"],
      busy: [],
      notBefore: (locationId) => (locationId === "salon" ? 24 * 60 : 0),
    });
    expect(slots.map((slot) => slot.locationId)).toEqual(["home"]);
  });
});

describe("cutting an opening into slots", () => {
  const opening = (start: number, end: number, locationId = "salon") => ({
    specialistId: "anna",
    locationId,
    start,
    end,
  });

  test("counts from where the opening begins, not from the clock", () => {
    // 09:40–12:00 at a 60-minute step: 09:40 and 10:40, not 10:00 and 11:00.
    const slots = splitIntoSlots([opening(580, 720)], () => 60);
    expect(slots.map((slot) => [slot.start, slot.end])).toEqual([
      [580, 640],
      [640, 700],
    ]);
  });

  test("drops what does not make a whole step", () => {
    // 20 minutes are left of 09:40–12:00 after two hours' worth of steps.
    expect(splitIntoSlots([opening(580, 720)], () => 60)).toHaveLength(2);
    expect(splitIntoSlots([opening(600, 650)], () => 60)).toEqual([]);
  });

  test("an opening exactly one step long is one slot, and two steps are two", () => {
    expect(splitIntoSlots([opening(600, 660)], () => 60)).toHaveLength(1);
    expect(splitIntoSlots([opening(600, 720)], () => 60)).toHaveLength(2);
  });

  test("uses each address's own step", () => {
    const slots = splitIntoSlots(
      [opening(600, 780, "salon"), opening(600, 780, "home")],
      (locationId) => (locationId === "salon" ? 90 : 60),
    );
    expect(slots.filter((slot) => slot.locationId === "salon")).toHaveLength(2);
    expect(slots.filter((slot) => slot.locationId === "home")).toHaveLength(3);
  });

  test("keeps the master and the address on every slot", () => {
    const slots = splitIntoSlots([opening(600, 720)], () => 30);
    expect(slots).toHaveLength(4);
    expect(slots.every((slot) => slot.specialistId === "anna" && slot.locationId === "salon")).toBe(true);
  });

  test("leaves an opening whole when the step is not a positive number", () => {
    expect(splitIntoSlots([opening(600, 720)], () => 0)).toEqual([opening(600, 720)]);
  });
});
