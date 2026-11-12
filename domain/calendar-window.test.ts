import { describe, expect, test } from "vitest";

import { calendarFrame, monthGrid, sameWindow } from "@/domain/calendar-window";
import { formatLocalDate, localDateWeekday } from "@/domain/timezone";

describe("monthGrid", () => {
  test("draws whole weeks from a Monday, around the month", () => {
    const grid = monthGrid({ year: 2026, month: 11, day: 12 });
    expect(localDateWeekday(grid[0])).toBe(1);
    expect(grid.length % 7).toBe(0);
    expect(formatLocalDate(grid[0])).toBe("2026-10-26");
    expect(formatLocalDate(grid.at(-1)!)).toBe("2026-12-06");
  });
});

describe("calendarFrame", () => {
  const noon = new Date("2026-11-12T12:00:00.000Z");

  test("selects today in the zone it is given", () => {
    expect(calendarFrame(noon, "UTC").selected).toBe("2026-11-12");
    // Fourteen hours ahead of UTC, it is already tomorrow.
    expect(calendarFrame(noon, "Pacific/Kiritimati").selected).toBe("2026-11-13");
  });

  test("a date in the address wins over today, whatever the zone", () => {
    expect(calendarFrame(noon, "Pacific/Kiritimati", "2026-11-03").selected).toBe("2026-11-03");
    expect(calendarFrame(noon, "Pacific/Kiritimati", "2026-11-03").today).toEqual({ year: 2026, month: 11, day: 13 });
  });

  test("reads a day beyond the grid at each end, in UTC", () => {
    const frame = calendarFrame(noon, "UTC");
    expect(frame.windowStart.toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(frame.windowEnd.toISOString()).toBe("2026-12-08T00:00:00.000Z");
  });
});

/*
 * The calendar starts reading its window on a guess — the studio's zone — and
 * checks the guess against the address's zone when it arrives. These are the
 * cases that decide whether it reads again.
 */
describe("sameWindow", () => {
  test("holds when both zones see the same day", () => {
    const noon = new Date("2026-11-12T12:00:00.000Z");
    expect(sameWindow(calendarFrame(noon, "Europe/Chisinau"), calendarFrame(noon, "UTC"))).toBe(true);
  });

  test("holds whenever the address names a date, since no zone moves it", () => {
    const late = new Date("2026-11-30T23:30:00.000Z");
    expect(
      sameWindow(calendarFrame(late, "UTC", "2026-11-14"), calendarFrame(late, "Pacific/Kiritimati", "2026-11-14")),
    ).toBe(true);
  });

  test("fails when the address's zone is already on another day", () => {
    const noon = new Date("2026-11-12T12:00:00.000Z");
    expect(sameWindow(calendarFrame(noon, "UTC"), calendarFrame(noon, "Pacific/Kiritimati"))).toBe(false);
  });

  test("fails when the other day is in another month, so the grid itself moves", () => {
    const late = new Date("2026-11-30T23:30:00.000Z");
    const guess = calendarFrame(late, "UTC");
    const truth = calendarFrame(late, "Europe/Chisinau");
    expect(guess.selected).toBe("2026-11-30");
    expect(truth.selected).toBe("2026-12-01");
    expect(guess.windowStart.getTime()).not.toBe(truth.windowStart.getTime());
    expect(sameWindow(guess, truth)).toBe(false);
  });
});
