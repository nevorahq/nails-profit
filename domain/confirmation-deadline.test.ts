import { describe, expect, it } from "vitest";

import {
  confirmationDeadline,
  confirmationMidpoint,
  DEFAULT_CONFIRMATION_TTL_MINUTES,
  movedConfirmationDeadline,
} from "@/domain/confirmation-deadline";

const now = new Date("2026-10-05T09:00:00.000Z");
const hoursFromNow = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

describe("confirmation deadline", () => {
  it("gives a new address twelve hours", () => {
    expect(DEFAULT_CONFIRMATION_TTL_MINUTES).toBe(720);
  });

  it("is the studio's window when the visit is far away", () => {
    expect(confirmationDeadline({ now, ttlMinutes: 720, startsAt: hoursFromNow(48) })).toEqual(
      hoursFromNow(12),
    );
  });

  it("stops two hours before the visit when the window would run past that", () => {
    expect(confirmationDeadline({ now, ttlMinutes: 720, startsAt: hoursFromNow(6) })).toEqual(
      hoursFromNow(4),
    );
  });

  it("applies the reserve to a short window chosen before the reserve existed", () => {
    // An address that kept the old 120 minutes: a visit three hours away leaves
    // one hour, not two.
    expect(confirmationDeadline({ now, ttlMinutes: 120, startsAt: hoursFromNow(3) })).toEqual(
      hoursFromNow(1),
    );
  });

  it("never gives less than fifteen minutes when the reserve no longer fits", () => {
    expect(confirmationDeadline({ now, ttlMinutes: 720, startsAt: hoursFromNow(1) })).toEqual(
      minutesFromNow(15),
    );
    // Reserve already in the past by an hour: still fifteen minutes.
    expect(confirmationDeadline({ now, ttlMinutes: 720, startsAt: minutesFromNow(60) })).toEqual(
      minutesFromNow(15),
    );
  });

  it("never waits past the appointment itself", () => {
    expect(confirmationDeadline({ now, ttlMinutes: 720, startsAt: minutesFromNow(10) })).toEqual(
      minutesFromNow(10),
    );
  });

  it("keeps a window shorter than the floor when the studio chose one", () => {
    expect(confirmationDeadline({ now, ttlMinutes: 15, startsAt: hoursFromNow(1) })).toEqual(
      minutesFromNow(15),
    );
  });
});

describe("a pending request moved to another hour", () => {
  it("keeps the deadline it had when the new hour is far enough", () => {
    expect(
      movedConfirmationDeadline({ current: hoursFromNow(5), now, startsAt: hoursFromNow(30) }),
    ).toEqual(hoursFromNow(5));
  });

  it("pulls the deadline in to the reserve of a closer hour", () => {
    expect(
      movedConfirmationDeadline({ current: hoursFromNow(5), now, startsAt: hoursFromNow(4) }),
    ).toEqual(hoursFromNow(2));
  });

  it("never pushes the deadline later, even to the fifteen-minute floor", () => {
    expect(
      movedConfirmationDeadline({ current: minutesFromNow(5), now, startsAt: hoursFromNow(1) }),
    ).toEqual(minutesFromNow(5));
  });
});

describe("the reminder's midpoint", () => {
  it("is halfway from the request to its deadline", () => {
    expect(confirmationMidpoint({ createdAt: now, dueAt: hoursFromNow(12) })).toEqual(hoursFromNow(6));
  });
});
