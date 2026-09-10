import { describe, expect, test } from "vitest";

import { clockAt, groupBookings } from "@/components/calendar-grouping";

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
