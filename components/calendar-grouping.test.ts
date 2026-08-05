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

  test("the list is everything in the window, ungrouped", () => {
    const groups = groupBookings("list", ["2026-08-03", "2026-08-16"], BOOKINGS, PEOPLE);
    expect(groups).toHaveLength(1);
    expect(groups[0].bookings).toHaveLength(4);
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
});
