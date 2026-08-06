/**
 * Rate limits for `/api/v1`, spec section 15.3: "rate limits для auth, public
 * links, imports и webhook endpoints".
 *
 * Better Auth limits its own routes; nothing limited ours. The two that need it
 * are import (a 2 MB file is read, decoded and parsed three times before a row
 * is written, so a loop of uploads is a denial of service with a valid session)
 * and invitation accept (a token guess costs the attacker one request).
 *
 * A fixed window, not a sliding one: the point is to cap the damage a loop can
 * do, and a fixed window does that with one integer per caller. The counters
 * live in memory, which means they are per instance — the same caveat as Better
 * Auth's own limiter, and correct for a single-instance pilot. A second
 * instance needs shared storage before either limit means what it says.
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

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/**
 * Expired entries are dropped on write once the map grows past this. Without a
 * sweep the map is a slow memory leak keyed by user id; with a timer it would
 * keep the process awake. A bound checked on write costs nothing.
 */
const SWEEP_THRESHOLD = 10_000;

function sweep(now: number) {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export function checkRateLimit(key: string, rule: RateLimitRule, now = Date.now()): RateLimitDecision {
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size >= SWEEP_THRESHOLD) sweep(now);
    windows.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1_000 });
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: rule.windowSeconds };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1_000));

  if (existing.count >= rule.limit) {
    // The count is not incremented on a refusal: a client that keeps hammering
    // must not push its own reset further away, which would turn a limit into a
    // lockout.
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true, remaining: rule.limit - existing.count, retryAfterSeconds };
}

/** Test seam; also what a deployment would call after swapping the storage. */
export function resetRateLimits() {
  windows.clear();
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
