import { describe, expect, it } from "vitest";

import {
  currencyForTimezone,
  DEFAULT_COMMISSION_PERCENT,
  DEFAULT_WORKWEEK,
} from "@/domain/workspace-defaults";
import { currencies } from "@/domain/money";

describe("the currency a browser's zone implies", () => {
  it("keeps the leu where the pilot is", () => {
    expect(currencyForTimezone("Europe/Chisinau")).toBe("MDL");
    expect(currencyForTimezone("Europe/Tiraspol")).toBe("MDL");
  });

  it("reads the rouble from membership rather than from a prefix", () => {
    // `Asia/` holds most of the world, so these are listed one by one — the
    // point of the test is that the list is what decides, not the continent.
    expect(currencyForTimezone("Europe/Moscow")).toBe("RUB");
    expect(currencyForTimezone("Asia/Yekaterinburg")).toBe("RUB");
    expect(currencyForTimezone("Asia/Vladivostok")).toBe("RUB");
  });

  it("offers the euro to the rest of Europe", () => {
    // Romania keeps the leu and Poland the złoty, and neither is a currency the
    // books can be kept in (`domain/money.ts`) — so the offer is the euro and
    // the picker beside it is how they disagree.
    expect(currencyForTimezone("Europe/Bucharest")).toBe("EUR");
    expect(currencyForTimezone("Europe/Warsaw")).toBe("EUR");
  });

  it("falls back to the pilot's own currency rather than inventing a fourth", () => {
    expect(currencyForTimezone("America/New_York")).toBe("MDL");
    expect(currencyForTimezone("Asia/Almaty")).toBe("MDL");
  });

  it("survives a browser that will not say where it is", () => {
    expect(currencyForTimezone(null)).toBe("MDL");
    expect(currencyForTimezone(undefined)).toBe("MDL");
    expect(currencyForTimezone("")).toBe("MDL");
  });

  it("never offers a currency the schema would refuse", () => {
    const offered = [
      "Europe/Chisinau",
      "Europe/Moscow",
      "Europe/Bucharest",
      "Pacific/Auckland",
      "",
    ].map((zone) => currencyForTimezone(zone));

    expect(offered.every((code) => (currencies as readonly string[]).includes(code))).toBe(true);
  });
});

describe("the defaults the setup screen arrives with", () => {
  it("opens five days at hours the rota endpoint would accept", () => {
    expect(DEFAULT_WORKWEEK.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_WORKWEEK.start < DEFAULT_WORKWEEK.end).toBe(true);
    for (const value of [DEFAULT_WORKWEEK.start, DEFAULT_WORKWEEK.end]) {
      expect(value).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("suggests a rate that is a rate", () => {
    // Zero would be a workspace whose owner is paid nothing and whose margin is
    // the whole price; a hundred leaves the business nothing. Both are legal
    // and neither is a default.
    expect(DEFAULT_COMMISSION_PERCENT).toBeGreaterThan(0);
    expect(DEFAULT_COMMISSION_PERCENT).toBeLessThan(100);
  });
});
