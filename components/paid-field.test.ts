import { describe, expect, it } from "vitest";

import { toMajorUnits, toMinorUnits } from "@/components/paid-field";

describe("toMinorUnits", () => {
  it("reads whole amounts and both decimal separators", () => {
    expect(toMinorUnits("450")).toBe(45_000);
    expect(toMinorUnits("450.5")).toBe(45_050);
    expect(toMinorUnits("450,50")).toBe(45_050);
    expect(toMinorUnits(" 0 ")).toBe(0);
  });

  it("refuses what is not an amount", () => {
    for (const input of ["", "-5", "4.505", "abc", "1e3", "450 лей"]) {
      expect(toMinorUnits(input)).toBeNull();
    }
  });
});

describe("toMajorUnits", () => {
  it("drops the decimals of a whole amount and keeps two otherwise", () => {
    expect(toMajorUnits(45_000)).toBe("450");
    expect(toMajorUnits(45_050)).toBe("450.50");
    expect(toMajorUnits(5)).toBe("0.05");
  });

  it("round-trips through toMinorUnits", () => {
    for (const minor of [0, 1, 99, 45_000, 45_050]) {
      expect(toMinorUnits(toMajorUnits(minor))).toBe(minor);
    }
  });
});
