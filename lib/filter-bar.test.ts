import { describe, expect, test } from "vitest";

import {
  dateIn,
  formatMonth,
  monthNames,
  parseMonth,
  queryFor,
  yearOptions,
} from "@/lib/filter-bar";

describe("the query a filter navigates to", () => {
  test("writes only the filters that are set", () => {
    expect(queryFor("/app/visits", { from: "2026-09-01", to: "", specialist: undefined })).toBe(
      "/app/visits?from=2026-09-01",
    );
  });

  test("is the bare path when nothing is filtered", () => {
    expect(queryFor("/app", { from: "", to: undefined })).toBe("/app");
  });

  /*
   * The reset link is built by dropping the dates and keeping the master, so
   * what it produces has to be a URL the page reads as "this master, all time"
   * rather than as "no filter at all".
   */
  test("keeps one filter while the others are cleared", () => {
    expect(queryFor("/app", { from: "", to: "", specialist: "anna" })).toBe("/app?specialist=anna");
  });
});

describe("the months a year is named in", () => {
  test("names twelve, in order", () => {
    const names = monthNames("en-GB", 2026);
    expect(names).toHaveLength(12);
    expect(names[0]).toBe("January");
    expect(names[11]).toBe("December");
  });

  /*
   * Read at midday on the fifteenth, not at midnight on the first: a
   * first-of-the-month instant is hours from the month before, and a browser
   * far enough west would name every month in this list one early.
   */
  test("names the month it is asked for in any zone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Niue";
      expect(monthNames("en-GB", 2026)[0]).toBe("January");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("the years a studio may reach for", () => {
  test("runs two back and one forward", () => {
    expect(yearOptions(2026, 2026)).toEqual([2024, 2025, 2026, 2027]);
  });

  test("adds a year the reader actually arrived on", () => {
    expect(yearOptions(2026, 2019)).toEqual([2019, 2024, 2025, 2026, 2027]);
    expect(yearOptions(2026, 2030)).toEqual([2024, 2025, 2026, 2027, 2030]);
  });

  test("does not list a year twice when the anchor is already in range", () => {
    expect(yearOptions(2026, 2025)).toEqual([2024, 2025, 2026, 2027]);
  });
});

describe("moving a date to another month or year", () => {
  test("keeps the day when the target has one", () => {
    expect(dateIn("2026-09-14", { month: 11 })).toBe("2026-11-14");
    expect(dateIn("2026-09-14", { year: 2024 })).toBe("2024-09-14");
  });

  /*
   * The trap this exists for: 31 February is 3 March to a calendar, so one
   * change of one field would move the reader two months.
   */
  test("clamps to the last day the target month has", () => {
    expect(dateIn("2026-01-31", { month: 2 })).toBe("2026-02-28");
    expect(dateIn("2026-03-31", { month: 4 })).toBe("2026-04-30");
  });

  test("knows which Februaries have a 29th", () => {
    expect(dateIn("2028-02-29", { year: 2027 })).toBe("2027-02-28");
    expect(dateIn("2028-02-29", { year: 2032 })).toBe("2032-02-29");
  });

  test("hands back anything that is not a date", () => {
    expect(dateIn("2026-09", { month: 2 })).toBe("2026-09");
    expect(dateIn("", { year: 2026 })).toBe("");
  });
});

describe("reading and writing a month", () => {
  test("round-trips", () => {
    expect(formatMonth(2026, 9)).toBe("2026-09");
    expect(parseMonth("2026-09")).toEqual({ year: 2026, month: 9 });
  });

  test("pads a single-digit month", () => {
    expect(formatMonth(2026, 1)).toBe("2026-01");
  });

  test("refuses a month that is not one", () => {
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseMonth("2026-00")).toBeNull();
    expect(parseMonth("2026-9")).toBeNull();
    expect(parseMonth("2026-09-14")).toBeNull();
  });
});
