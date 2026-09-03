import { describe, expect, test } from "vitest";

import { callerKey, decideRateLimit, type RateLimitRule } from "@/lib/rate-limit";

const rule: RateLimitRule = { limit: 3, windowSeconds: 60 };

/**
 * The counting itself is one SQL statement and is tested against a real
 * database in `tests/integration/rate-limit.test.ts` — a fake would only prove
 * that the fake agrees with itself, and the property that matters (two callers
 * on two instances share one counter) cannot be observed in this process at
 * all. What is left here is the arithmetic on the row that comes back, which is
 * where the off-by-one lives.
 */
describe("decideRateLimit", () => {
  const now = 1_000_000;
  const windowEndsAt = now + rule.windowSeconds * 1_000;

  test("allows up to and including the limit, then refuses", () => {
    expect(decideRateLimit({ hits: 1, windowEndsAt }, rule, now).allowed).toBe(true);
    expect(decideRateLimit({ hits: 3, windowEndsAt }, rule, now).allowed).toBe(true);
    expect(decideRateLimit({ hits: 3, windowEndsAt }, rule, now).remaining).toBe(0);
    expect(decideRateLimit({ hits: 4, windowEndsAt }, rule, now).allowed).toBe(false);
  });

  test("counts the allowance down and stops at zero", () => {
    expect(decideRateLimit({ hits: 1, windowEndsAt }, rule, now).remaining).toBe(2);
    // Hammering keeps incrementing, and "minus four remaining" is not a number
    // anyone should read off a header.
    expect(decideRateLimit({ hits: 7, windowEndsAt }, rule, now).remaining).toBe(0);
  });

  test("a refused request does not push the reset away", () => {
    // The window end comes from the row, which the statement only rewrites once
    // the window is actually over; retrying in a loop must not extend the wait,
    // or a limit becomes a lockout.
    expect(decideRateLimit({ hits: 9, windowEndsAt }, rule, now + 10_000).retryAfterSeconds).toBe(50);
    expect(decideRateLimit({ hits: 10, windowEndsAt }, rule, now + 20_000).retryAfterSeconds).toBe(40);
  });

  test("retry-after is never zero inside the window", () => {
    const decision = decideRateLimit({ hits: 4, windowEndsAt }, rule, windowEndsAt - 1);
    expect(decision.allowed).toBe(false);
    // A Retry-After of 0 invites an instant retry that is certain to fail.
    expect(decision.retryAfterSeconds).toBe(1);
  });
});

describe("callerKey", () => {
  test("prefers the session over the forwarded address", () => {
    const request = new Request("http://localhost/api/v1/imports", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(callerKey(request, "user-1")).toBe("user:user-1");
  });

  test("falls back to the first forwarded address", () => {
    const request = new Request("http://localhost/api/v1/imports", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(callerKey(request, null)).toBe("ip:203.0.113.7");
  });

  test("an absent address still yields one bucket rather than none", () => {
    const request = new Request("http://localhost/api/v1/imports");
    expect(callerKey(request, null)).toBe("ip:unknown");
  });
});
