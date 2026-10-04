import { describe, expect, it } from "vitest";

import { keepsManualVisit, manualVisitSpan } from "./calendar-visits";

describe("the hours a visit closed by hand took", () => {
  const completedAt = new Date("2026-10-02T16:07:00.000Z");

  it("end when it was closed and start its actual length before", () => {
    const span = manualVisitSpan({ completedAt, plannedDurationMinutes: 90, actualDurationMinutes: 60 });
    expect(span.startsAt.toISOString()).toBe("2026-10-02T15:07:00.000Z");
    expect(span.endsAt).toBe(completedAt);
  });

  it("take the planned length when nobody said how long it took", () => {
    const span = manualVisitSpan({ completedAt, plannedDurationMinutes: 90, actualDurationMinutes: null });
    expect(span.startsAt.toISOString()).toBe("2026-10-02T14:37:00.000Z");
  });

  it("are a moment, not a negative span, for a visit of no length", () => {
    const span = manualVisitSpan({ completedAt, plannedDurationMinutes: 0, actualDurationMinutes: null });
    expect(span.startsAt.getTime()).toBe(completedAt.getTime());
  });
});

describe("the calendar's filters on a visit closed by hand", () => {
  const atA = { specialistLocationIds: ["a"] };

  it("keep it when nothing is narrowed", () => {
    expect(keepsManualVisit(atA, { location: "", statuses: [] })).toBe(true);
  });

  it("treat it as completed", () => {
    expect(keepsManualVisit(atA, { location: "", statuses: ["completed", "confirmed"] })).toBe(true);
    expect(keepsManualVisit(atA, { location: "", statuses: ["confirmed"] })).toBe(false);
  });

  it("keep it for an address its master works at, and no other", () => {
    expect(keepsManualVisit(atA, { location: "a", statuses: [] })).toBe(true);
    expect(keepsManualVisit(atA, { location: "b", statuses: [] })).toBe(false);
    expect(keepsManualVisit({ specialistLocationIds: [] }, { location: "a", statuses: [] })).toBe(false);
  });
});
