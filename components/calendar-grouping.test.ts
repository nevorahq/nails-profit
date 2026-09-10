import { describe, expect, test } from "vitest";

import { clockAt, freeWindows, groupBookings, rotaFor, toHalfHours, totalMinutes } from "@/components/calendar-grouping";

const PEOPLE = [
  { id: "anna", name: "Анна" },
  { id: "irina", name: "Ирина" },
  { id: "olga", name: "Ольга" },
];

const BOOKINGS = [
  { id: "1", localDate: "2026-08-05", specialistId: "anna" },
  { id: "2", localDate: "2026-08-05", specialistId: "irina" },
  { id: "3", localDate: "2026-08-05", specialistId: "anna" },
  { id: "4", localDate: "2026-08-06", specialistId: "olga" },
];

describe("grouping the calendar", () => {
  test("a day is one section per specialist who has something", () => {
    const groups = groupBookings("day", ["2026-08-05"], BOOKINGS, PEOPLE);

    expect(groups.map((group) => group.title)).toEqual(["Анна", "Ирина"]);
    expect(groups[0].bookings.map((booking) => booking.id)).toEqual(["1", "3"]);
    // Ольга has nothing today; a column saying so is not information.
    expect(groups.some((group) => group.title === "Ольга")).toBe(false);
  });

  test("an empty day is one empty section, not a row of empty columns", () => {
    const groups = groupBookings("day", ["2026-08-07"], BOOKINGS, PEOPLE);
    expect(groups).toHaveLength(1);
    expect(groups[0].bookings).toEqual([]);
  });

  test("a week keeps every day, including the ones with nothing in them", () => {
    const days = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"];
    const groups = groupBookings("week", days, BOOKINGS, PEOPLE);

    // A quiet Monday is a fact about the week and has to stay visible.
    expect(groups.map((group) => group.key)).toEqual(days);
    expect(groups[0].bookings).toEqual([]);
    expect(groups[2].bookings.map((booking) => booking.id)).toEqual(["1", "2", "3"]);
  });

  /**
   * The list used to come back whole — every master's appointments in one run,
   * a client's Thursday between two of somebody else's. It answers the same
   * question the day view does, over a longer window, so it is grouped the same
   * way: whose is this.
   */
  test("the list is one column per specialist across the whole window", () => {
    const groups = groupBookings("list", ["2026-08-03", "2026-08-16"], BOOKINGS, PEOPLE);

    // Ольга is here and was not in the day view: her booking is on the 6th, and
    // the window covers it.
    expect(groups.map((group) => group.title)).toEqual(["Анна", "Ирина", "Ольга"]);
    expect(groups.flatMap((group) => group.bookings)).toHaveLength(4);
    // Anna's two, ordered as they came in, and nobody else's.
    expect(groups[0].bookings.map((booking) => booking.id)).toEqual(["1", "3"]);
  });

  /**
   * An empty window keeps the panel it always had. A row of columns for people
   * with nothing in any of them says less than the dates do.
   */
  test("an empty list stays one section headed by its dates", () => {
    const groups = groupBookings("list", ["2026-08-03", "2026-08-16"], [], PEOPLE);

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("2026-08-03 — 2026-08-16");
    expect(groups[0].bookings).toEqual([]);
  });

  /**
   * The same rule as the day view's, so a master the studio has parted with
   * keeps a column for the appointments that outlived them.
   */
  test("the list gives an archived specialist a column too", () => {
    const groups = groupBookings(
      "list",
      ["2026-09-10", "2026-09-16"],
      [
        { id: "a", localDate: "2026-09-12", specialistId: "gone", specialistName: "Маша" },
        { id: "b", localDate: "2026-09-14", specialistId: "anna" },
      ],
      PEOPLE,
    );

    expect(groups.map((group) => group.title)).toEqual(["Анна", "Маша"]);
  });
});

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

  test("keeps a day's appointments when their master has left the studio", () => {
    /*
     * Two right answers made a wrong one. The columns are drawn from the live
     * roster, because a column for everybody who ever left would grow forever;
     * the appointments are not filtered that way, because a client's Tuesday
     * does not disappear when the studio parts with somebody. Together they
     * dropped the appointment off the one day it most needed to be seen — the
     * day after the owner let somebody go and was told to move their clients.
     */
    const groups = groupBookings(
      "day",
      ["2026-09-12"],
      [
        { id: "a", localDate: "2026-09-12", specialistId: "gone", specialistName: "Маша" },
        { id: "b", localDate: "2026-09-12", specialistId: "here" },
      ],
      [{ id: "here", name: "Ирина" }],
    );

    expect(groups.map((group) => group.title)).toEqual(["Ирина", "Маша"]);
    expect(groups.find((group) => group.key === "gone")?.bookings.map((b) => b.id)).toEqual(["a"]);
  });

  test("draws one column for a departed master however many appointments they left", () => {
    const groups = groupBookings(
      "day",
      ["2026-09-12"],
      [
        { id: "a", localDate: "2026-09-12", specialistId: "gone", specialistName: "Маша" },
        { id: "b", localDate: "2026-09-12", specialistId: "gone", specialistName: "Маша" },
      ],
      [],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].bookings.map((b) => b.id)).toEqual(["a", "b"]);
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
