import { afterEach, describe, expect, it, vi } from "vitest";

import { formatLongDate, formatPercentDelta } from "@/lib/format";

describe("formatPercentDelta", () => {
  it("reports a rise against the prior period", () => {
    const delta = formatPercentDelta(28_540_00, 25_390_00, "ru-MD");
    expect(delta?.direction).toBe("up");
    expect(delta?.text).toContain("12");
  });

  it("reports a fall against the prior period", () => {
    const delta = formatPercentDelta(9_430_00, 12_000_00, "ru-MD");
    expect(delta?.direction).toBe("down");
  });

  it("has no delta when there was nothing to compare against", () => {
    // A prior period with zero profit is not a 100% drop from nothing; it is
    // not a comparison at all.
    expect(formatPercentDelta(5_000, 0, "ru-MD")).toBeNull();
  });

  it("reads a loss-to-loss change by the size of the loss, not its sign", () => {
    // From a 10 000 loss to a 5 000 loss is an improvement, read the same way
    // a revenue rise would be: `direction: "up"`.
    const delta = formatPercentDelta(-5_000, -10_000, "ru-MD");
    expect(delta?.direction).toBe("up");
  });
});

describe("formatLongDate", () => {
  // 05:00 UTC is 08:00 in Chișinău in October.
  const monday = new Date("2026-10-05T05:00:00Z");
  const zone = { timeZone: "Europe/Chisinau" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spells out the day, the year and the time in each of the product's languages", () => {
    const full = { ...zone, year: true, time: true };
    expect(formatLongDate(monday, "ru-MD", full)).toBe("понедельник, 5 октября 2026 г. в 08:00");
    expect(formatLongDate(monday, "ro-MD", full)).toBe("luni, 5 octombrie 2026 la 08:00");
    expect(formatLongDate(monday, "en-GB", full)).toBe("Monday 5 October 2026 at 08:00");
  });

  it("names the day alone when asked for nothing more", () => {
    expect(formatLongDate(monday, "ru-MD", zone)).toBe("понедельник, 5 октября");
    expect(formatLongDate(monday, "ro-MD", zone)).toBe("luni, 5 octombrie");
    expect(formatLongDate(monday, "en-GB", zone)).toBe("Monday 5 October");
  });

  it("adds the year without the time", () => {
    expect(formatLongDate(monday, "ru-MD", { ...zone, year: true })).toBe("понедельник, 5 октября 2026 г.");
    expect(formatLongDate(monday, "en-GB", { ...zone, year: true })).toBe("Monday 5 October 2026");
  });

  it("reads the day in the zone it is given, not the machine's", () => {
    const lateEvening = new Date("2026-10-05T22:30:00Z");
    expect(formatLongDate(lateEvening, "en-GB", { timeZone: "UTC", time: true })).toBe("Monday 5 October at 22:30");
    expect(formatLongDate(lateEvening, "en-GB", { ...zone, time: true })).toBe("Tuesday 6 October at 01:30");
  });

  /*
   * The reason it exists: two runtimes with different CLDR data join the same
   * names differently, and a page rendered on one and hydrated on the other
   * must still read the same. Whatever the runtime puts between the names is
   * not used.
   */
  it("does not take its punctuation from the runtime", () => {
    const real = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (
      this: Intl.DateTimeFormat,
      date,
    ) {
      return real
        .call(this, date)
        .map((part) => (part.type === "literal" ? { ...part, value: " ~ " } : part));
    });

    expect(formatLongDate(monday, "en-GB", { ...zone, year: true, time: true })).toBe(
      "Monday 5 October 2026 at 08:00",
    );
    expect(formatLongDate(monday, "ru-MD", { ...zone, year: true, time: true })).toBe(
      "понедельник, 5 октября 2026 г. в 08:00",
    );
  });
});
