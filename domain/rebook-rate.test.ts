import { describe, expect, test } from "vitest";

import { rebookRate, rebookRateDeltaPoints } from "@/domain/rebook-rate";

const visits = (...ids: string[]) => ids.map((bookingId) => ({ bookingId }));

describe("rebookRate", () => {
  test("nothing to divide is no rate, not zero", () => {
    expect(rebookRate([], [])).toEqual({ eligible: 0, rebooked: 0, rateBasisPoints: null });
  });

  test("the share of visits that left with the next one booked", () => {
    expect(
      rebookRate(visits("a", "b", "c"), [{ rebookedFromBookingId: "a", status: "confirmed" }]),
    ).toEqual({ eligible: 3, rebooked: 1, rateBasisPoints: 3_333 });
  });

  test("a cancelled rebooking is not a return", () => {
    expect(
      rebookRate(visits("a", "b"), [{ rebookedFromBookingId: "a", status: "cancelled" }]).rebooked,
    ).toBe(0);
  });

  test("a no-show still counts: at the visit the client did book", () => {
    expect(rebookRate(visits("a"), [{ rebookedFromBookingId: "a", status: "no_show" }]).rebooked).toBe(1);
  });

  test("two rebookings of one visit are one, and a cancelled one beside a kept one does not undo it", () => {
    expect(
      rebookRate(visits("a", "b"), [
        { rebookedFromBookingId: "a", status: "cancelled" },
        { rebookedFromBookingId: "a", status: "confirmed" },
        { rebookedFromBookingId: "a", status: "completed" },
      ]),
    ).toEqual({ eligible: 2, rebooked: 1, rateBasisPoints: 5_000 });
  });

  test("a rebooking of a visit outside the period does not count in it", () => {
    expect(rebookRate(visits("a"), [{ rebookedFromBookingId: "z", status: "confirmed" }]).rebooked).toBe(0);
  });

  test("rounds half away from zero", () => {
    // 1 of 8 is 12.5% → 1250 exactly; 1 of 6 is 16.666…% → 1667.
    expect(rebookRate(visits("a", "b", "c", "d", "e", "f", "g", "h"), [{ rebookedFromBookingId: "a", status: "confirmed" }]).rateBasisPoints).toBe(1_250);
    expect(rebookRate(visits("a", "b", "c", "d", "e", "f"), [{ rebookedFromBookingId: "a", status: "confirmed" }]).rateBasisPoints).toBe(1_667);
  });
});

describe("rebookRateDeltaPoints", () => {
  const rate = (rateBasisPoints: number | null) => ({ eligible: 1, rebooked: 0, rateBasisPoints });

  test("in percentage points, not relative change", () => {
    expect(rebookRateDeltaPoints(rate(3_000), rate(2_000))).toBe(10);
    expect(rebookRateDeltaPoints(rate(2_000), rate(3_000))).toBe(-10);
  });

  test("no delta without both periods", () => {
    expect(rebookRateDeltaPoints(rate(3_000), null)).toBeNull();
    expect(rebookRateDeltaPoints(rate(3_000), rate(null))).toBeNull();
    expect(rebookRateDeltaPoints(rate(null), rate(3_000))).toBeNull();
  });
});
