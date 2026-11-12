import { describe, expect, test } from "vitest";

import { POLL_INTERVAL_MS, shouldPoll } from "@/lib/notification-poll";

describe("shouldPoll", () => {
  const now = 1_800_000_000_000;

  test("a tab that has not checked yet checks at once", () => {
    expect(shouldPoll("visible", null, now)).toBe(true);
  });

  test("a hidden tab never checks, however stale its answer", () => {
    expect(shouldPoll("hidden", null, now)).toBe(false);
    expect(shouldPoll("hidden", now - 10 * POLL_INTERVAL_MS, now)).toBe(false);
  });

  test("a visible tab waits an interval between checks", () => {
    expect(shouldPoll("visible", now - 5_000, now)).toBe(false);
    expect(shouldPoll("visible", now - POLL_INTERVAL_MS, now)).toBe(true);
  });

  test("a timer firing a few milliseconds early still gets its turn", () => {
    expect(shouldPoll("visible", now - (POLL_INTERVAL_MS - 20), now)).toBe(true);
  });

  test("coming back to a tab after a long time away checks once at once", () => {
    expect(shouldPoll("visible", now - 45 * 60_000, now)).toBe(true);
  });
});
