import { describe, expect, it } from "vitest";

import { MAX_SERVICE_MINUTES, openingSetupProblems } from "@/domain/opening-setup";

const manicure = { priceMinor: 20_000, durationMinutes: 60 };
const week = { weekdays: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 16 * 60 };

describe("what the opening screen will not save", () => {
  it("takes a priced service and a week", () => {
    expect(openingSetupProblems({ services: [manicure], week })).toEqual([]);
  });

  it("takes a studio's services with no week of its own", () => {
    expect(openingSetupProblems({ services: [manicure] })).toEqual([]);
    expect(openingSetupProblems({ services: [manicure], week: null })).toEqual([]);
  });

  it("refuses to open with nothing to sell", () => {
    expect(openingSetupProblems({ services: [], week })).toEqual([{ field: "services", code: "none" }]);
  });

  it("refuses a service nobody priced, at zero or below", () => {
    for (const priceMinor of [0, -100, 12.5]) {
      expect(openingSetupProblems({ services: [manicure, { ...manicure, priceMinor }] })).toEqual([
        { field: "services.1.price_minor", code: "price_required" },
      ]);
    }
  });

  it("refuses a length that is not a working length", () => {
    for (const durationMinutes of [0, -30, 45.5, MAX_SERVICE_MINUTES + 1]) {
      expect(openingSetupProblems({ services: [{ ...manicure, durationMinutes }] })).toEqual([
        { field: "services.0.duration_minutes", code: "duration_range" },
      ]);
    }
    expect(openingSetupProblems({ services: [{ ...manicure, durationMinutes: MAX_SERVICE_MINUTES }] })).toEqual([]);
  });

  it("refuses a week with no day in it", () => {
    expect(openingSetupProblems({ services: [manicure], week: { ...week, weekdays: [] } })).toEqual([
      { field: "workweek.weekdays", code: "no_days" },
    ]);
  });

  it("refuses hours that end before they start, or did not parse", () => {
    for (const hours of [
      { startMinute: 16 * 60, endMinute: 8 * 60 },
      { startMinute: 9 * 60, endMinute: 9 * 60 },
      { startMinute: null, endMinute: 16 * 60 },
      { startMinute: 8 * 60, endMinute: null },
    ]) {
      expect(openingSetupProblems({ services: [manicure], week: { ...week, ...hours } })).toEqual([
        { field: "workweek.hours", code: "invalid_hours" },
      ]);
    }
  });

  it("names every problem at once, so the screen can mark them together", () => {
    expect(
      openingSetupProblems({
        services: [{ priceMinor: 0, durationMinutes: 0 }],
        week: { weekdays: [], startMinute: 10, endMinute: 5 },
      }).map((problem) => problem.code),
    ).toEqual(["price_required", "duration_range", "no_days", "invalid_hours"]);
  });
});
