import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { DEFAULT_DIFFICULTY_BITS, isSolved } from "@/domain/proof-of-work";
import { getServerEnv } from "@/env";

/**
 * The bot challenge of roadmap section 7.9, and the suspicion that switches it
 * on.
 *
 * Nothing is challenged until a caller has earned it. A client who books an
 * appointment sees none of this; a caller that has been refused ten times in
 * ten minutes — rate limits, wrong codes, slots that were never free — is asked
 * to spend some CPU before the next attempt is answered.
 *
 * The challenge is stateless where it can be and stateful only where it must
 * be. The nonce carries its own expiry and an HMAC, so the server does not have
 * to remember every challenge it ever issued; what it does remember is the
 * nonces already spent, because a proof of work that can be replayed is a
 * proof of nothing.
 */
const SUSPICION_THRESHOLD = 10;
const SUSPICION_WINDOW_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const SWEEP_THRESHOLD = 10_000;

type Suspicion = { count: number; resetAt: number };

const suspicion = new Map<string, Suspicion>();
const spent = new Map<string, number>();

function sweep(now: number) {
  for (const [key, entry] of suspicion) if (entry.resetAt <= now) suspicion.delete(key);
  for (const [nonce, expiresAt] of spent) if (expiresAt <= now) spent.delete(nonce);
}

/**
 * One refusal a legitimate client would rarely see.
 *
 * Counted per caller, not per endpoint: a loop that spreads itself across
 * holds, verification and booking is the shape this is meant to notice.
 */
export function recordSuspiciousActivity(key: string, now = Date.now()) {
  const existing = suspicion.get(key);
  if (!existing || existing.resetAt <= now) {
    if (suspicion.size >= SWEEP_THRESHOLD) sweep(now);
    suspicion.set(key, { count: 1, resetAt: now + SUSPICION_WINDOW_MS });
    return 1;
  }

  existing.count += 1;
  return existing.count;
}

export function challengeRequired(key: string, now = Date.now()) {
  const existing = suspicion.get(key);
  if (!existing || existing.resetAt <= now) return false;
  return existing.count >= SUSPICION_THRESHOLD;
}

export type IssuedChallenge = Readonly<{
  nonce: string;
  difficulty_bits: number;
  expires_at: string;
}>;

/**
 * The nonce is `expiry.random.signature`: everything needed to check it later
 * travels with it, so a restarted process still refuses a forged one and still
 * accepts a challenge it issued a minute before dying.
 */
export function issueChallenge(key: string, now = Date.now()): IssuedChallenge {
  const expiresAt = now + CHALLENGE_TTL_MS;
  const body = `${expiresAt}.${randomBytes(16).toString("base64url")}`;
  return {
    nonce: `${body}.${sign(key, body)}`,
    difficulty_bits: DEFAULT_DIFFICULTY_BITS,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

export type ChallengeVerdict = "ok" | "missing" | "invalid" | "expired" | "spent" | "unsolved";

/**
 * `header` is `<nonce>:<solution>` — one header rather than two, because the
 * pair is meaningless apart and a client that sends half of it has a bug rather
 * than a partial credential.
 */
export function verifyChallenge(
  key: string,
  header: string | null,
  now = Date.now(),
): ChallengeVerdict {
  if (!header) return "missing";

  const separator = header.lastIndexOf(":");
  if (separator <= 0) return "invalid";

  const nonce = header.slice(0, separator);
  const solution = header.slice(separator + 1);
  const parts = nonce.split(".");
  if (parts.length !== 3) return "invalid";

  const [expiry, random, signature] = parts;
  if (!matches(sign(key, `${expiry}.${random}`), signature)) return "invalid";

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return "expired";
  // Bound to the caller by the signature and to one attempt by this map: the
  // work has to be redone for the next request, which is the entire cost.
  if (spent.has(nonce)) return "spent";
  if (!isSolved(nonce, solution, DEFAULT_DIFFICULTY_BITS)) return "unsolved";

  if (spent.size >= SWEEP_THRESHOLD) sweep(now);
  spent.set(nonce, expiresAt);
  return "ok";
}

function sign(key: string, body: string) {
  return createHmac("sha256", getServerEnv().BETTER_AUTH_SECRET)
    .update(`challenge:${key}:${body}`, "utf8")
    .digest("base64url");
}

function matches(expected: string, supplied: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Test seam, like `resetRateLimits`. */
export function resetBotChallenges() {
  suspicion.clear();
  spent.clear();
}
