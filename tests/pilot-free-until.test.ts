import { afterEach, describe, expect, it } from "vitest";

import { getPilotFreeUntil } from "@/env";

describe("PILOT_FREE_UNTIL", () => {
  const previous = process.env.PILOT_FREE_UNTIL;
  afterEach(() => {
    if (previous === undefined) delete process.env.PILOT_FREE_UNTIL;
    else process.env.PILOT_FREE_UNTIL = previous;
  });

  it("keeps pilots free with no end while unset", () => {
    delete process.env.PILOT_FREE_UNTIL;
    expect(getPilotFreeUntil()).toBeNull();
    process.env.PILOT_FREE_UNTIL = " ";
    expect(getPilotFreeUntil()).toBeNull();
  });

  it("counts the named day as free and ends at the next midnight UTC", () => {
    process.env.PILOT_FREE_UNTIL = "2027-01-31";
    expect(getPilotFreeUntil()).toEqual(new Date("2027-02-01T00:00:00Z"));
  });

  it("refuses anything that is not a date", () => {
    for (const value of ["31.01.2027", "2027-1-31", "soon", "2027-13-40"]) {
      process.env.PILOT_FREE_UNTIL = value;
      expect(() => getPilotFreeUntil()).toThrow("PILOT_FREE_UNTIL must be a date as YYYY-MM-DD");
    }
  });
});
