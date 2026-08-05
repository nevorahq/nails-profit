import { describe, expect, test } from "vitest";

import {
  addLocalDays,
  compareLocalDates,
  formatLocalDate,
  formatLocalTime,
  isSupportedTimezone,
  localDateWeekday,
  localToUtc,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
  toZonedParts,
  zoneOffsetMinutes,
} from "@/domain/timezone";

const CHISINAU = "Europe/Chisinau";

describe("zone offsets", () => {
  test("Moldova is UTC+2 in winter and UTC+3 in summer", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), CHISINAU)).toBe(120);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), CHISINAU)).toBe(180);
  });

  test("an unknown zone is not supported rather than silently UTC", () => {
    expect(isSupportedTimezone(CHISINAU)).toBe(true);
    expect(isSupportedTimezone("Asia/Tbilisi")).toBe(true);
    expect(isSupportedTimezone("Mars/Olympus")).toBe(false);
  });

  test("reading the wall clock back gives the local date and minutes", () => {
    const parts = toZonedParts(new Date("2026-07-15T06:30:00Z"), CHISINAU);
    expect(parts).toEqual({ year: 2026, month: 7, day: 15, minutes: 9 * 60 + 30, weekday: 3 });
  });
});

describe("resolveLocal", () => {
  test("an ordinary local time maps to exactly one instant", () => {
    const resolved = resolveLocal({ year: 2026, month: 7, day: 15 }, 9 * 60, CHISINAU);
    expect(resolved.kind).toBe("exact");
    expect(resolved.instant.toISOString()).toBe("2026-07-15T06:00:00.000Z");
  });

  test("winter and summer differ by the hour the clocks moved", () => {
    expect(localToUtc({ year: 2026, month: 1, day: 15 }, 9 * 60, CHISINAU).toISOString()).toBe(
      "2026-01-15T07:00:00.000Z",
    );
    expect(localToUtc({ year: 2026, month: 7, day: 15 }, 9 * 60, CHISINAU).toISOString()).toBe(
      "2026-07-15T06:00:00.000Z",
    );
  });

  /**
   * 29 March 2026: at 03:00 the clocks go to 04:00. Every wall time in that
   * hour is a time nobody in Moldova experiences.
   */
  test.each([0, 15, 30, 45, 59])("03:%d on a spring-forward day does not exist", (minute) => {
    const resolved = resolveLocal({ year: 2026, month: 3, day: 29 }, 3 * 60 + minute, CHISINAU);
    expect(resolved.kind).toBe("gap");
    // The instant offered is where the jump lands: 01:00 UTC is 04:00 local.
    expect(resolved.instant.toISOString()).toBe(
      new Date(Date.UTC(2026, 2, 29, 1, minute)).toISOString(),
    );
  });

  test("the hour before and after the spring gap are ordinary", () => {
    expect(resolveLocal({ year: 2026, month: 3, day: 29 }, 2 * 60 + 59, CHISINAU).kind).toBe("exact");
    expect(resolveLocal({ year: 2026, month: 3, day: 29 }, 4 * 60, CHISINAU).kind).toBe("exact");
  });

  /**
   * 25 October 2026: at 04:00 the clocks go back to 03:00, so 03:00–03:59
   * happens twice — once at UTC+3 and once at UTC+2.
   */
  test.each([0, 30, 59])("03:%d on a fall-back day happens twice", (minute) => {
    const resolved = resolveLocal({ year: 2026, month: 10, day: 25 }, 3 * 60 + minute, CHISINAU);
    expect(resolved.kind).toBe("ambiguous");

    if (resolved.kind !== "ambiguous") return;
    expect(resolved.instant.toISOString()).toBe(new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString());
    expect(resolved.second.toISOString()).toBe(new Date(Date.UTC(2026, 9, 25, 1, minute)).toISOString());
    // A schedule opens the first time the clock reads 03:00, never the second.
    expect(resolved.instant.getTime()).toBeLessThan(resolved.second.getTime());
    expect(localToUtc({ year: 2026, month: 10, day: 25 }, 3 * 60 + minute, CHISINAU)).toEqual(
      resolved.instant,
    );
  });

  test("a whole ordinary day roundtrips through the conversion", () => {
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const instant = localToUtc({ year: 2026, month: 7, day: 15 }, minutes, CHISINAU);
      const back = toZonedParts(instant, CHISINAU);
      expect(back.minutes).toBe(minutes);
      expect(back.day).toBe(15);
    }
  });

  test("zones without DST and zones ahead of the line behave the same way", () => {
    // A studio configured for a zone that never shifts must not acquire a gap.
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      expect(resolveLocal({ year: 2026, month: 3, day: 29 }, minutes, "Asia/Tbilisi").kind).toBe("exact");
    }
    expect(localToUtc({ year: 2026, month: 3, day: 29 }, 9 * 60, "Asia/Tbilisi").toISOString()).toBe(
      "2026-03-29T05:00:00.000Z",
    );
  });
});

describe("local calendar arithmetic", () => {
  test("adding days never touches an instant, so DST cannot shift a date", () => {
    // 29 March 2026 is a 23-hour day in Chisinau; the calendar does not care.
    expect(addLocalDays({ year: 2026, month: 3, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 29 });
    expect(addLocalDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addLocalDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
  });

  test("weekdays are ISO: Monday is 1 and Sunday is 7", () => {
    expect(localDateWeekday({ year: 2026, month: 8, day: 3 })).toBe(1);
    expect(localDateWeekday({ year: 2026, month: 8, day: 9 })).toBe(7);
  });

  test("dates compare as dates", () => {
    expect(compareLocalDates({ year: 2026, month: 1, day: 2 }, { year: 2026, month: 1, day: 10 })).toBeLessThan(0);
    expect(compareLocalDates({ year: 2026, month: 2, day: 1 }, { year: 2026, month: 1, day: 31 })).toBeGreaterThan(0);
    expect(compareLocalDates({ year: 2026, month: 5, day: 5 }, { year: 2026, month: 5, day: 5 })).toBe(0);
  });
});

describe("parsing", () => {
  test("a date roundtrips and an impossible one is rejected", () => {
    expect(parseLocalDate("2026-08-05")).toEqual({ year: 2026, month: 8, day: 5 });
    expect(formatLocalDate({ year: 2026, month: 8, day: 5 })).toBe("2026-08-05");
    // Without the roundtrip check this would quietly become 2 March.
    expect(parseLocalDate("2026-02-30")).toBeNull();
    expect(parseLocalDate("2026-8-5")).toBeNull();
    expect(parseLocalDate("not a date")).toBeNull();
  });

  test("a time is minutes from midnight", () => {
    expect(parseLocalTime("09:30")).toBe(570);
    expect(parseLocalTime("00:00")).toBe(0);
    expect(parseLocalTime("23:59")).toBe(1_439);
    expect(parseLocalTime("24:00")).toBeNull();
    expect(parseLocalTime("09:60")).toBeNull();
    expect(parseLocalTime("9:30")).toBeNull();
    expect(formatLocalTime(570)).toBe("09:30");
    expect(formatLocalTime(1_439)).toBe("23:59");
  });
});
