import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db";
import { checkRateLimit, resetRateLimits, type RateLimitRule } from "@/lib/rate-limit";
import { closeTestConnections } from "../helpers/database";

const rule: RateLimitRule = { limit: 3, windowSeconds: 60 };

/** The window this key is inside, as the database sees it. */
async function windowEndOf(key: string) {
  const rows = await db.execute<{ window_expires_at: string | Date }>(
    sql`select window_expires_at from rate_limit_window where bucket_key = ${key}`,
  );
  const row = [...rows][0];
  return row ? new Date(row.window_expires_at).getTime() : null;
}

/** Move a live window into the past, which is the only way to age one quickly. */
async function expireWindow(key: string) {
  await db.execute(
    sql`update rate_limit_window set window_expires_at = now() - interval '1 second' where bucket_key = ${key}`,
  );
}

describe("rate limits", () => {
  beforeEach(async () => {
    await resetRateLimits();
  });

  afterAll(async () => {
    await resetRateLimits();
    await closeTestConnections();
  });

  test("allows up to the limit and then refuses", async () => {
    expect((await checkRateLimit("k", rule)).allowed).toBe(true);
    expect((await checkRateLimit("k", rule)).allowed).toBe(true);
    expect((await checkRateLimit("k", rule)).remaining).toBe(0);
    expect((await checkRateLimit("k", rule)).allowed).toBe(false);
  });

  test("keys are independent", async () => {
    for (let index = 0; index < rule.limit; index += 1) await checkRateLimit("first", rule);

    expect((await checkRateLimit("first", rule)).allowed).toBe(false);
    expect((await checkRateLimit("second", rule)).allowed).toBe(true);
  });

  test("the window reopens once it is over", async () => {
    for (let index = 0; index < rule.limit; index += 1) await checkRateLimit("k", rule);
    expect((await checkRateLimit("k", rule)).allowed).toBe(false);

    await expireWindow("k");

    const reopened = await checkRateLimit("k", rule);
    expect(reopened.allowed).toBe(true);
    expect(reopened.remaining).toBe(rule.limit - 1);
  });

  test("a refused request does not push the reset away", async () => {
    for (let index = 0; index < rule.limit; index += 1) await checkRateLimit("k", rule);
    const endsAt = await windowEndOf("k");

    // Hammering at the limit must not extend the wait — otherwise a client that
    // retries in a loop locks itself out for good.
    for (let index = 0; index < 5; index += 1) {
      expect((await checkRateLimit("k", rule)).allowed).toBe(false);
    }

    expect(await windowEndOf("k")).toBe(endsAt);
  });

  /**
   * The reason the counters left the process.
   *
   * On Netlify a caller's requests are spread across lambdas, each with its own
   * memory. With the counts in a `Map` this test's second half started from
   * zero and served three more requests, which is exactly how a limit of ten an
   * hour let an abuser through and refused an honest client at random. Reloading
   * the module is the closest thing in one process to a second instance: fresh
   * module state, same database.
   */
  test("a second instance continues the same count rather than starting over", async () => {
    for (let index = 0; index < rule.limit; index += 1) await checkRateLimit("shared", rule);

    vi.resetModules();
    const fresh = await import("@/lib/rate-limit");

    const decision = await fresh.checkRateLimit("shared", rule);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  /**
   * Two requests arriving together must not both take the last slot. A limiter
   * that read the count and then wrote it would let them, and concurrency is
   * the case it exists for — one client tapping twice, or a loop by design.
   */
  test("simultaneous requests spend the allowance exactly once each", async () => {
    const attempts = await Promise.all(
      Array.from({ length: rule.limit + 5 }, () => checkRateLimit("burst", rule)),
    );

    expect(attempts.filter((decision) => decision.allowed)).toHaveLength(rule.limit);
  });

  test("the caller waits out the window it is actually in", async () => {
    for (let index = 0; index < rule.limit; index += 1) await checkRateLimit("k", rule);

    const decision = await checkRateLimit("k", rule);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(rule.windowSeconds);
  });
});
