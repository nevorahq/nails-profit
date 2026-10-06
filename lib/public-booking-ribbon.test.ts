import { describe, expect, it } from "vitest";

import { dateInZone, firstDayWithTimes } from "@/lib/public-booking-ribbon";

describe("dateInZone", () => {
  // 22:30 UTC on 6 October: already the 7th in Chișinău (UTC+3), still the 6th in Lisbon.
  const lateEvening = new Date("2026-10-06T22:30:00Z");

  it("starts the ribbon on the location's today, not the device's", () => {
    expect(dateInZone("Europe/Chisinau", lateEvening)).toBe("2026-10-07");
    expect(dateInZone("Europe/Lisbon", lateEvening)).toBe("2026-10-06");
  });

  it("follows daylight saving: Chișinău is UTC+2 after the clocks go back", () => {
    // 22:30 UTC on 1 November is 00:30 on the 2nd at UTC+2, not 01:30 at +3.
    expect(dateInZone("Europe/Chisinau", new Date("2026-11-01T22:30:00Z"))).toBe("2026-11-02");
    expect(dateInZone("Europe/Chisinau", new Date("2026-11-01T21:30:00Z"))).toBe("2026-11-01");
  });
});

describe("firstDayWithTimes", () => {
  it("selects the first day that has a time, skipping empty ones", () => {
    expect(
      firstDayWithTimes([
        { date: "2026-10-07", slots: [] },
        { date: "2026-10-08", slots: [{}] },
        { date: "2026-10-09", slots: [{}, {}] },
      ]),
    ).toBe("2026-10-08");
  });

  it("selects today when today has times", () => {
    expect(firstDayWithTimes([{ date: "2026-10-07", slots: [{}] }])).toBe("2026-10-07");
  });

  it("is null for a week with nothing free, and for no days at all", () => {
    expect(firstDayWithTimes([{ date: "2026-10-07", slots: [] }, { date: "2026-10-08", slots: [] }])).toBeNull();
    expect(firstDayWithTimes([])).toBeNull();
  });
});
