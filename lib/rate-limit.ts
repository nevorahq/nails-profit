import { sql } from "drizzle-orm";

import { db } from "@/db";
import { findPostgresError } from "@/lib/db-errors";
import { logEvent } from "@/lib/logger";

/**
 * Rate limits for `/api/v1`, spec section 15.3: "rate limits для auth, public
 * links, imports и webhook endpoints".
 *
 * Better Auth limits its own routes; nothing limited ours. The two that need it
 * are import (a 2 MB file is read, decoded and parsed three times before a row
 * is written, so a loop of uploads is a denial of service with a valid session)
 * and invitation accept (a token guess costs the attacker one request). Public
 * booking has its own buckets on top.
 *
 * A fixed window, not a sliding one: the point is to cap the damage a loop can
 * do, and a fixed window does that with one integer per caller.
 *
 * The counters live in PostgreSQL, one row per bucket. They used to live in a
 * `Map` in the process, with a comment calling that "correct for a
 * single-instance pilot" — and production stopped being one instance the day it
 * moved to lambdas. Each one started with an empty map, so "ten an hour" was
 * ten per instance per hour: an abuser kept knocking until a fresh instance
 * answered, and an honest client was refused by whichever instance happened to
 * hold their count. The database is already on the path of every request this
 * limiter guards, so counting there costs one round trip and buys a number that
 * means what it says.
 */
export type RateLimitRule = Readonly<{
  limit: number;
  windowSeconds: number;
}>;

export type RateLimitDecision = Readonly<{
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets; what the Retry-After header carries. */
  retryAfterSeconds: number;
}>;

/** Ten uploads an hour is far more than an import flow needs and far less than a loop wants. */
export const IMPORT_UPLOAD_RULE: RateLimitRule = { limit: 10, windowSeconds: 3_600 };
export const IMPORT_CONFIRM_RULE: RateLimitRule = { limit: 20, windowSeconds: 3_600 };
/** An invitation token is 256 bits, so this is about cost, not about guessing odds. */
export const INVITATION_ACCEPT_RULE: RateLimitRule = { limit: 10, windowSeconds: 3_600 };
/** Public booking has separate buckets so slot browsing cannot consume create allowance. */
export const PUBLIC_BOOKING_READ_RULE: RateLimitRule = { limit: 120, windowSeconds: 60 };
export const PUBLIC_BOOKING_AVAILABILITY_RULE: RateLimitRule = { limit: 60, windowSeconds: 60 };
export const PUBLIC_BOOKING_HOLD_RULE: RateLimitRule = { limit: 20, windowSeconds: 600 };
export const PUBLIC_BOOKING_CREATE_RULE: RateLimitRule = { limit: 10, windowSeconds: 3_600 };
/** Its own bucket, section 7.9: guessing codes must not be paid for out of the create budget. */
export const PUBLIC_BOOKING_VERIFY_RULE: RateLimitRule = { limit: 15, windowSeconds: 3_600 };
export const PUBLIC_BOOKING_MANAGE_RULE: RateLimitRule = { limit: 30, windowSeconds: 3_600 };

export type CountedWindow = Readonly<{ hits: number; windowEndsAt: number }>;

/**
 * What the row means, once it has been counted.
 *
 * Separated from the statement that produces it so the arithmetic — which is
 * the part with an off-by-one in it — can be read and tested without a
 * database. `hits` is the count *including* this request, so the limit-th
 * request is allowed and the one after it is not.
 */
export function decideRateLimit(
  window: CountedWindow,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitDecision {
  return {
    allowed: window.hits <= rule.limit,
    remaining: Math.max(0, rule.limit - window.hits),
    // Never zero: "try again in no time at all" is not an instruction, and it
    // is what a window ending this millisecond would otherwise produce.
    retryAfterSeconds: Math.max(1, Math.ceil((window.windowEndsAt - now) / 1_000)),
  };
}

/**
 * Count one event against a key and return the window it landed in.
 *
 * One statement, and it has to be one: a read followed by a write would let two
 * concurrent requests both see the last free slot in the window and both take
 * it, which is precisely the case a limiter exists for. The upsert takes the
 * row lock, so callers on the same key serialize and each sees the count that
 * includes itself.
 *
 * A refusal still increments, and deliberately: what must not move is the
 * *reset*, because a client that keeps hammering would otherwise push its own
 * window away and turn a limit into a lockout. `window_expires_at` is written
 * once per window and only replaced when that window is already over.
 *
 * Shared with the bot challenge, which counts suspicion the same way and claims
 * a solved nonce by counting it: "has this been seen before" is the same
 * question as "how many times", asked once.
 */
export async function countInWindow(key: string, windowSeconds: number): Promise<CountedWindow> {
  const rows = await db.execute<{ hits: number; window_expires_at: string | Date }>(sql`
    insert into rate_limit_window as w (bucket_key, hits, window_expires_at)
    values (
      ${key},
      1,
      now() + make_interval(secs => ${windowSeconds}::double precision)
    )
    on conflict (bucket_key) do update
      set hits = case when w.window_expires_at <= now() then 1 else w.hits + 1 end,
          window_expires_at = case
            when w.window_expires_at <= now()
              then now() + make_interval(secs => ${windowSeconds}::double precision)
            else w.window_expires_at
          end
    returning w.hits, w.window_expires_at
  `);

  const row = [...rows][0];
  if (!row) throw new Error("the window upsert returned no row");
  return { hits: Number(row.hits), windowEndsAt: new Date(row.window_expires_at).getTime() };
}

/**
 * What a key stands at, without counting anything against it.
 *
 * The read half, for callers asking "how often has this happened" on a request
 * that is not itself the thing being counted — the bot challenge asks it of
 * every public mutation, and answering by incrementing would make each honest
 * request its own evidence. A lapsed window reads as zero, not as its stale
 * count.
 */
export async function peekWindow(key: string): Promise<number> {
  const rows = await db.execute<{ hits: number }>(
    sql`select hits from rate_limit_window where bucket_key = ${key} and window_expires_at > now()`,
  );
  const row = [...rows][0];
  return row ? Number(row.hits) : 0;
}

/** Forget every key under a prefix. A test seam, and an operator's amnesty. */
export async function forgetWindows(prefix: string) {
  await db.execute(sql`delete from rate_limit_window where bucket_key like ${`${prefix}%`}`);
}

/**
 * Count this request and say whether it is within the rule.
 *
 * The try/catch is what makes the limiter fail open, and it is why this stays
 * one call rather than two the caller has to remember to pair.
 */
export async function checkRateLimit(
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitDecision> {
  try {
    return decideRateLimit(await countInWindow(key, rule.windowSeconds), rule);
  } catch (error) {
    /*
     * Fail open. A limiter is a guard rail, not the product: if the database
     * cannot be reached, the booking page that depends on the very same
     * database is already answering 500s, and refusing everyone here would add
     * a second outage on top of the first without protecting anything. Logged
     * at error level because an unreachable limiter is exactly the window an
     * abuser wants, and nobody would otherwise know it was open.
     */
    logEvent("error", "rate_limit.unavailable", {}, {
      bucket: key.slice(0, key.indexOf(":")) || key,
      ...describeFailure(error),
    });
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: rule.windowSeconds };
  }
}

/** Test seam; also what an operator would call to forgive every caller at once. */
export async function resetRateLimits() {
  await db.execute(sql`delete from rate_limit_window`);
}

/**
 * Who is being limited. A session is the accurate answer — the limits here
 * protect against an authenticated loop. The forwarded address is the fallback
 * for callers with no session, and it is only ever a fallback: behind a proxy
 * it is client-controlled, so it must never widen anyone's allowance.
 */
export function callerKey(request: Request, userId: string | null) {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || "unknown"}`;
}

/**
 * The driver's own words, not drizzle's wrapper.
 *
 * Drizzle raises "Failed query: <sql>" and hangs the PostgresError off `cause`,
 * so a log that reads `error.message` prints the statement it already knows and
 * nothing about why it was refused. That is exactly what happened the first
 * time this shipped: the line said the upsert failed and gave no SQLSTATE, and
 * the diagnosis took a round trip through a human with database access.
 */
function describeFailure(error: unknown) {
  const pg = findPostgresError(error);
  return {
    reason: pg?.message ?? (error instanceof Error ? error.message : String(error)),
    sqlstate: pg?.code ?? null,
    detail: pg?.detail ?? null,
  };
}
