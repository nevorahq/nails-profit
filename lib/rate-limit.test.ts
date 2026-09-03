import { beforeEach, describe, expect, test } from "vitest";

import { callerKey, checkRateLimit, resetRateLimits, type RateLimitRule } from "@/lib/rate-limit";

const rule: RateLimitRule = { limit: 3, windowSeconds: 60 };

beforeEach(() => {
  resetRateLimits();
});

describe("checkRateLimit", () => {
  test("allows up to the limit and then refuses", () => {
    const now = 1_000_000;

    expect(checkRateLimit("k", rule, now).allowed).toBe(true);
    expect(checkRateLimit("k", rule, now).allowed).toBe(true);
    expect(checkRateLimit("k", rule, now).remaining).toBe(0);
    expect(checkRateLimit("k", rule, now).allowed).toBe(false);
  });

  test("keys are independent", () => {
    const now = 1_000_000;
    for (let index = 0; index < rule.limit; index += 1) checkRateLimit("first", rule, now);

    expect(checkRateLimit("first", rule, now).allowed).toBe(false);
    expect(checkRateLimit("second", rule, now).allowed).toBe(true);
  });

  test("the window reopens after it expires", () => {
    const now = 1_000_000;
    for (let index = 0; index < rule.limit; index += 1) checkRateLimit("k", rule, now);
    expect(checkRateLimit("k", rule, now).allowed).toBe(false);

    expect(checkRateLimit("k", rule, now + rule.windowSeconds * 1_000).allowed).toBe(true);
  });

  test("a refused request does not push the reset away", () => {
    const now = 1_000_000;
    for (let index = 0; index < rule.limit; index += 1) checkRateLimit("k", rule, now);

    // Hammering at the limit must not extend the wait — otherwise a client that
    // retries in a loop locks itself out for good.
    const first = checkRateLimit("k", rule, now + 10_000);
    const second = checkRateLimit("k", rule, now + 20_000);
    expect(first.retryAfterSeconds).toBe(50);
    expect(second.retryAfterSeconds).toBe(40);
  });

  test("retry-after is never zero inside the window", () => {
    const now = 1_000_000;
    for (let index = 0; index < rule.limit; index += 1) checkRateLimit("k", rule, now);

    const decision = checkRateLimit("k", rule, now + rule.windowSeconds * 1_000 - 1);
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
