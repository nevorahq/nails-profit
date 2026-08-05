import { describe, expect, it } from "vitest";

import {
  parseBoolean,
  parseDurationMinutes,
  parseIntegerValue,
  parseLocalDate,
  parseMilliUnits,
  parseMoneyMinor,
  parseNumberParts,
  parsePercentBasisPoints,
} from "@/domain/import-values";

describe("parseMoneyMinor", () => {
  it("accepts both decimal separators", () => {
    expect(parseMoneyMinor("240,50")).toBe(24_050);
    expect(parseMoneyMinor("240.50")).toBe(24_050);
  });

  it("does not go through a float", () => {
    // parseFloat("240.55") * 100 is 24054.999999999996.
    expect(parseMoneyMinor("240.55")).toBe(24_055);
    // 1234.565 * 100 is 123456.49999999999 in floating point, so a float path
    // rounds this down to 123456 and loses a ban.
    expect(parseMoneyMinor("1.234,565")).toBe(123_457);
  });

  it("reads thousands separators", () => {
    expect(parseMoneyMinor("1 200")).toBe(120_000);
    expect(parseMoneyMinor("1 234,50")).toBe(123_450);
    expect(parseMoneyMinor("1.234,50")).toBe(123_450);
    expect(parseMoneyMinor("1,234.50")).toBe(123_450);
  });

  it("resolves the ambiguous single separator toward thousands", () => {
    // "1,200" is 1200 to an English writer and 1.2 to a Russian one; three
    // trailing digits after a plausible leading group reads as grouping.
    expect(parseMoneyMinor("1,200")).toBe(120_000);
    expect(parseMoneyMinor("1.005")).toBe(100_500);
    // ...but a leading zero is never a thousands group, so this is 0.5.
    expect(parseMoneyMinor("0,500")).toBe(50);
  });

  it("rounds half away from zero", () => {
    expect(parseMoneyMinor("0,005")).toBe(1);
    expect(parseMoneyMinor("-0,005")).toBe(-1);
  });

  it("rejects what is not a number", () => {
    expect(parseMoneyMinor("бесплатно")).toBeNull();
    expect(parseMoneyMinor("")).toBeNull();
    expect(parseMoneyMinor("300 лей")).toBeNull();
  });
});

describe("parseNumberParts", () => {
  it("keeps sign, integer and fraction separate", () => {
    expect(parseNumberParts("-12,34")).toEqual({ negative: true, integer: "12", fraction: "34" });
  });

  it("reads a value written with no integer part", () => {
    expect(parseNumberParts(",5")).toEqual({ negative: false, integer: "0", fraction: "5" });
  });
});

describe("parseMilliUnits", () => {
  it("keeps three decimal places", () => {
    expect(parseMilliUnits("0,3")).toBe(300);
    expect(parseMilliUnits("2")).toBe(2_000);
    expect(parseMilliUnits("0,0005")).toBe(1);
  });
});

describe("parseIntegerValue", () => {
  it("accepts a whole number written with a zero fraction", () => {
    expect(parseIntegerValue("90")).toBe(90);
    expect(parseIntegerValue("90,0")).toBe(90);
  });

  it("refuses to silently truncate a real fraction", () => {
    expect(parseIntegerValue("90,5")).toBeNull();
  });
});

describe("parseDurationMinutes", () => {
  it("reads the forms a price list actually uses", () => {
    expect(parseDurationMinutes("90")).toBe(90);
    expect(parseDurationMinutes("1:30")).toBe(90);
    expect(parseDurationMinutes("1ч 30м")).toBe(90);
    expect(parseDurationMinutes("1 ч 30 мин")).toBe(90);
    expect(parseDurationMinutes("1h30")).toBe(90);
    expect(parseDurationMinutes("2ч")).toBe(120);
  });

  it("treats a bare number as minutes", () => {
    // "2" in a duration column is two minutes only in theory; but reading it as
    // two hours would silently triple every profit-per-hour figure, so the
    // literal reading is the safe one and the preview shows it.
    expect(parseDurationMinutes("2")).toBe(2);
  });

  it("rejects nonsense", () => {
    expect(parseDurationMinutes("около часа")).toBeNull();
    expect(parseDurationMinutes("")).toBeNull();
  });
});

describe("parsePercentBasisPoints", () => {
  it("reads a commission percentage", () => {
    expect(parsePercentBasisPoints("40")).toBe(4_000);
    expect(parsePercentBasisPoints("40%")).toBe(4_000);
    expect(parsePercentBasisPoints("40,5%")).toBe(4_050);
  });
});

describe("parseLocalDate", () => {
  it("reads dd.MM.yyyy as LOC-007 requires", () => {
    expect(parseLocalDate("03.04.2026")?.toISOString()).toBe("2026-04-03T00:00:00.000Z");
  });

  it("reads dd/MM/yyyy the same way, not the American way", () => {
    // `new Date("03/04/2026")` is March 4th. Every file this product receives
    // means April 3rd, and a visit in the wrong month lands in the wrong period.
    expect(parseLocalDate("03/04/2026")?.getUTCMonth()).toBe(3);
  });

  it("reads ISO", () => {
    expect(parseLocalDate("2026-04-03")?.toISOString()).toBe("2026-04-03T00:00:00.000Z");
  });

  it("reads a time alongside the date", () => {
    expect(parseLocalDate("03.04.2026 14:30")?.toISOString()).toBe("2026-04-03T14:30:00.000Z");
  });

  it("rejects a day that does not exist", () => {
    // Date.UTC would roll 31.02 forward into March rather than fail.
    expect(parseLocalDate("31.02.2026")).toBeNull();
  });

  it("rejects a date it cannot read", () => {
    expect(parseLocalDate("вчера")).toBeNull();
  });
});

describe("parseBoolean", () => {
  it("reads yes and no in the three interface languages", () => {
    expect(parseBoolean("да")).toBe(true);
    expect(parseBoolean("Da")).toBe(true);
    expect(parseBoolean("yes")).toBe(true);
    expect(parseBoolean("нет")).toBe(false);
    expect(parseBoolean("nu")).toBe(false);
    expect(parseBoolean("")).toBe(false);
  });

  it("returns null for something it does not understand", () => {
    expect(parseBoolean("иногда")).toBeNull();
  });
});
