import { describe, expect, it } from "vitest";

import {
  decideAfterFailure,
  MAX_DELIVERY_ATTEMPTS,
  reminderTimeFor,
  retryDelaySeconds,
} from "@/domain/notification-schedule";

const now = new Date("2026-09-02T09:00:00.000Z");

describe("retry delay", () => {
  it("grows with each failure", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(300);
    expect(retryDelaySeconds(3)).toBe(1_500);
  });

  it("stops growing at an hour", () => {
    // A provider that is down is not helped by waiting longer than this, and a
    // message that waits a day is a message that arrives after the appointment.
    expect(retryDelaySeconds(4)).toBe(3_600);
    expect(retryDelaySeconds(40)).toBe(3_600);
  });
});

describe("what happens after a failure", () => {
  it("schedules the next attempt while attempts remain", () => {
    const decision = decideAfterFailure(1, true, now);
    expect(decision).toEqual({
      status: "retry",
      nextAttemptAt: new Date("2026-09-02T09:01:00.000Z"),
    });
  });

  it("dead-letters the last attempt", () => {
    expect(decideAfterFailure(MAX_DELIVERY_ATTEMPTS, true, now)).toEqual({ status: "dead_letter" });
  });

  it("does not retry what cannot succeed", () => {
    // An address the provider rejects will be rejected the same way five times.
    expect(decideAfterFailure(1, false, now)).toEqual({ status: "dead_letter" });
  });
});

describe("reminder time", () => {
  it("is the interval before the appointment", () => {
    expect(reminderTimeFor(new Date("2026-09-04T09:00:00.000Z"), 1_440, now)).toEqual(
      new Date("2026-09-03T09:00:00.000Z"),
    );
  });

  it("is nothing when the appointment is sooner than the interval", () => {
    // Booking two hours ahead with a 24-hour reminder: the moment to remind is
    // in the past, and a reminder sent now is a second confirmation.
    expect(reminderTimeFor(new Date("2026-09-02T11:00:00.000Z"), 1_440, now)).toBeNull();
  });

  it("is nothing when reminders are switched off", () => {
    expect(reminderTimeFor(new Date("2026-09-04T09:00:00.000Z"), 0, now)).toBeNull();
  });
});
