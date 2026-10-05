import { describe, expect, it } from "vitest";

import {
  currentMonthIn,
  monthRange,
  presetRanges,
  previousMonth,
  previousRangeOf,
  resolveReportPeriod,
  todayIn,
  wholeMonthOf,
} from "@/domain/report-period";

const CHISINAU = "Europe/Chisinau";

describe("the month the studio is in", () => {
  it("is still the old month on the evening of its last day in Chișinău", () => {
    // 31 October 2026, 23:30 local: summer time has ended, so UTC+2.
    const lateEvening = new Date("2026-10-31T21:30:00.000Z");
    expect(currentMonthIn(lateEvening, CHISINAU)).toBe("2026-10");
    expect(todayIn(lateEvening, CHISINAU)).toEqual({ year: 2026, month: 10, day: 31 });
  });

  it("is already the new month after local midnight, while UTC is still in the old one", () => {
    // 1 October 2026, 01:30 local (UTC+3 in summer time) is 30 September in UTC.
    const afterMidnight = new Date("2026-09-30T22:30:00.000Z");
    expect(afterMidnight.toISOString().slice(0, 7)).toBe("2026-09");
    expect(currentMonthIn(afterMidnight, CHISINAU)).toBe("2026-10");
  });

  it("turns the year with the studio's clock", () => {
    const newYearsNight = new Date("2026-12-31T22:30:00.000Z");
    expect(currentMonthIn(newYearsNight, CHISINAU)).toBe("2027-01");
    expect(currentMonthIn(newYearsNight, "UTC")).toBe("2026-12");
  });
});

describe("month arithmetic", () => {
  it("knows how long each month is, February of a leap year included", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(monthRange("2026-04")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });

  it("steps back over a new year", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-10")).toBe("2026-09");
  });

  it("recognises a whole month and nothing else", () => {
    expect(wholeMonthOf("2026-09-01", "2026-09-30")).toBe("2026-09");
    expect(wholeMonthOf("2026-09-01", "2026-09-29")).toBeNull();
    expect(wholeMonthOf("2026-09-02", "2026-09-30")).toBeNull();
    expect(wholeMonthOf("2026-09-01", "2026-10-31")).toBeNull();
    expect(wholeMonthOf("2026-09-01", undefined)).toBeNull();
    expect(wholeMonthOf(undefined, "2026-09-30")).toBeNull();
    expect(wholeMonthOf("2026-02-30", "2026-02-28")).toBeNull();
  });
});

describe("the quick buttons", () => {
  it("name this month, the last one and the calendar year", () => {
    expect(presetRanges({ year: 2026, month: 1, day: 15 })).toEqual({
      this_month: { from: "2026-01-01", to: "2026-01-31" },
      last_month: { from: "2025-12-01", to: "2025-12-31" },
      year: { from: "2026-01-01", to: "2026-12-31" },
    });
  });
});

describe("the period the report opens on", () => {
  const today = { year: 2026, month: 10, day: 5 };

  it("is this month when the address says nothing", () => {
    expect(resolveReportPeriod({}, today)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      preset: "this_month",
      month: "2026-10",
    });
  });

  it("recognises each quick button by its days", () => {
    expect(resolveReportPeriod({ from: "2026-10-01", to: "2026-10-31" }, today).preset).toBe("this_month");
    expect(resolveReportPeriod({ from: "2026-09-01", to: "2026-09-30" }, today)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      preset: "last_month",
      month: "2026-09",
    });
    expect(resolveReportPeriod({ from: "2026-01-01", to: "2026-12-31" }, today)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
      preset: "year",
      month: null,
    });
  });

  it("keeps an old bookmark's days, a whole month among them", () => {
    expect(resolveReportPeriod({ from: "2025-03-01", to: "2025-03-31" }, today)).toEqual({
      from: "2025-03-01",
      to: "2025-03-31",
      preset: "custom",
      month: "2025-03",
    });
    expect(resolveReportPeriod({ from: "2026-09-10", to: "2026-09-20" }, today)).toEqual({
      from: "2026-09-10",
      to: "2026-09-20",
      preset: "custom",
      month: null,
    });
  });

  it("keeps an open end open", () => {
    expect(resolveReportPeriod({ from: "2026-09-10" }, today)).toEqual({
      from: "2026-09-10",
      to: undefined,
      preset: "custom",
      month: null,
    });
    expect(resolveReportPeriod({ to: "2026-09-10" }, today).preset).toBe("custom");
  });
});

describe("the period a delta is measured against", () => {
  it("is the previous calendar month for a whole month", () => {
    expect(previousRangeOf({ from: "2026-03-01", to: "2026-03-31", preset: "custom", month: "2026-03" })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(previousRangeOf({ from: "2026-01-01", to: "2026-01-31", preset: "custom", month: "2026-01" })).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("is the same number of days right before any other closed period", () => {
    expect(previousRangeOf({ from: "2026-09-10", to: "2026-09-20", preset: "custom", month: null })).toEqual({
      from: "2026-08-30",
      to: "2026-09-09",
    });
    expect(previousRangeOf({ from: "2026-01-01", to: "2026-12-31", preset: "year", month: null })).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("does not exist for an open or reversed period", () => {
    expect(previousRangeOf({ from: "2026-09-10", preset: "custom", month: null })).toBeNull();
    expect(previousRangeOf({ to: "2026-09-10", preset: "custom", month: null })).toBeNull();
    expect(previousRangeOf({ from: "2026-09-20", to: "2026-09-10", preset: "custom", month: null })).toBeNull();
    expect(previousRangeOf({ from: "2026-02-30", to: "2026-03-10", preset: "custom", month: null })).toBeNull();
  });
});
