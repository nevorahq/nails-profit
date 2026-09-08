import { describe, expect, it } from "vitest";

import { soloNeedsPrincipal } from "@/domain/principal";

describe("soloNeedsPrincipal", () => {
  it("warns a solo studio whose only card is not marked", () => {
    expect(soloNeedsPrincipal("solo", [false])).toBe(true);
  });

  it("says nothing once the mark is on", () => {
    expect(soloNeedsPrincipal("solo", [true])).toBe(false);
  });

  it("says nothing before anybody is catalogued", () => {
    // The studio is still on «Первый расчёт»; the card the mark belongs on
    // does not exist yet.
    expect(soloNeedsPrincipal("solo", [])).toBe(false);
  });

  it("leaves a studio alone, marked or not", () => {
    // A studio's masters are paid out of the business, so an unmarked
    // catalogue is the ordinary case rather than a mistake.
    expect(soloNeedsPrincipal("studio", [false, false])).toBe(false);
    expect(soloNeedsPrincipal("studio", [true, false])).toBe(false);
  });

  it("is satisfied by any one mark among several", () => {
    // A solo studio that has taken on a second pair of hands without changing
    // its format still has its owner marked, and that is what the add-back
    // needs.
    expect(soloNeedsPrincipal("solo", [false, true])).toBe(false);
  });
});
