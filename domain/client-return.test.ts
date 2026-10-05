import { describe, expect, test } from "vitest";

import { medianDays, returnDue, RETURN_GRACE_DAYS, type ReturnVisit } from "@/domain/client-return";

function visit(day: string, specialistId = "irina", hour = 12): ReturnVisit {
  return { day, completedAt: new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`), specialistId };
}

/** Three visits ten and eleven days apart, out of order on purpose; the last is 1 June. */
const RHYTHM = [visit("2026-05-11"), visit("2026-06-01"), visit("2026-05-21")];

function due(today: string, overrides: Partial<Parameters<typeof returnDue>[0]> = {}) {
  return returnDue({ visits: RHYTHM, today, hasFutureBooking: false, archived: false, ...overrides });
}

describe("returnDue", () => {
  test("a client with one visit has no rhythm to be late against", () => {
    expect(due("2027-01-01", { visits: [visit("2026-06-01")] })).toBeNull();
  });

  test("two visits on one day are one visit", () => {
    expect(
      due("2027-01-01", { visits: [visit("2026-06-01", "irina", 10), visit("2026-06-01", "irina", 15)] }),
    ).toBeNull();
  });

  test("a client already booked is not called back", () => {
    expect(due("2026-08-01", { hasFutureBooking: true })).toBeNull();
    expect(due("2026-08-01")).not.toBeNull();
  });

  test("an archived client is not called back", () => {
    expect(due("2026-08-01", { archived: true })).toBeNull();
  });

  test("the median of the gaps is the interval, and the last visit is the latest closed", () => {
    // Gaps 10 and 11 — mean 10.5, rounded to 11.
    expect(due("2026-08-01")).toMatchObject({ intervalDays: 11, lastVisitDay: "2026-06-01" });
  });

  test("due only once more than the interval plus a week has passed", () => {
    // Interval 11 days from 1 June: 11 + 7 = 18 days → 19 June is the last day
    // still inside, 20 June the first one out.
    expect(RETURN_GRACE_DAYS).toBe(7);
    expect(due("2026-06-19")).toBeNull();
    expect(due("2026-06-20")).toMatchObject({ daysSinceLastVisit: 19, overdueDays: 8 });
  });

  test("a master sees a client only when the latest visit was theirs", () => {
    const visits = [visit("2026-05-01", "irina"), visit("2026-05-20", "olga")];
    expect(due("2026-08-01", { visits, viewerSpecialistId: "irina" })).toBeNull();
    expect(due("2026-08-01", { visits, viewerSpecialistId: "olga" })).toMatchObject({ lastSpecialistId: "olga" });
    // The whole studio sees them either way.
    expect(due("2026-08-01", { visits })).not.toBeNull();
  });

  test("the latest of two visits on one day decides whose client it is", () => {
    const visits = [visit("2026-05-01", "irina"), visit("2026-05-20", "olga", 18), visit("2026-05-20", "irina", 9)];
    expect(due("2026-08-01", { visits, viewerSpecialistId: "olga" })).not.toBeNull();
    expect(due("2026-08-01", { visits, viewerSpecialistId: "irina" })).toBeNull();
  });
});

describe("medianDays", () => {
  test("odd count takes the middle", () => {
    expect(medianDays([30, 14, 21])).toBe(21);
  });

  test("one long absence does not move the median", () => {
    expect(medianDays([21, 21, 120, 20, 22])).toBe(21);
  });
});
