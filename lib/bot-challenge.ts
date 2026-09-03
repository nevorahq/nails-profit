import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { DEFAULT_DIFFICULTY_BITS, isSolved } from "@/domain/proof-of-work";
import { getServerEnv } from "@/env";
import { logEvent } from "@/lib/logger";
import { countInWindow, forgetWindows, peekWindow } from "@/lib/rate-limit";

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
 *
 * Both pieces of memory live in the database, in the same counter table the
 * rate limiter uses. They were two `Map`s in the process, and on a deployment
 * that answers from several lambdas that made the mechanism a good deal weaker
 * than it reads: the suspicion count was divided among instances, so a caller
 * had to be refused ten times *by one lambda* before anything switched on, and
 * the spent-nonce set was local, so one proof of work could be replayed once
 * per instance. A counter shared across instances is what makes ten mean ten
 * and once mean once.
 */
const SUSPICION_THRESHOLD = 10;
const SUSPICION_WINDOW_SECONDS = 10 * 60;
const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Two namespaces in one table. Suspicion counts a caller; a nonce counts
 * itself, and its window is its own remaining life — by the time that row
 * lapses the nonce is expired anyway and refused before anything reads it.
 */
const SUSPICION_KEY = "bot_challenge.suspicion:";
const NONCE_KEY = "bot_challenge.nonce:";

/**
 * One refusal a legitimate client would rarely see.
 *
 * Counted per caller, not per endpoint: a loop that spreads itself across
 * holds, verification and booking is the shape this is meant to notice.
 */
export async function recordSuspiciousActivity(key: string): Promise<number> {
  try {
    const { hits } = await countInWindow(`${SUSPICION_KEY}${key}`, SUSPICION_WINDOW_SECONDS);
    return hits;
  } catch (error) {
    // Fail open, like the limiter beside it and for the same reason: a database
    // that cannot record suspicion is one the endpoints behind it cannot use
    // either, and a challenge nobody can be asked for protects nothing.
    unavailable("record", error);
    return 0;
  }
}

export async function challengeRequired(key: string): Promise<boolean> {
  try {
    return (await peekWindow(`${SUSPICION_KEY}${key}`)) >= SUSPICION_THRESHOLD;
  } catch (error) {
    unavailable("require", error);
    return false;
  }
}

function unavailable(stage: string, error: unknown) {
  logEvent("error", "bot_challenge.unavailable", {}, {
    stage,
    reason: error instanceof Error ? error.message : String(error),
  });
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
export async function verifyChallenge(
  key: string,
  header: string | null,
  now = Date.now(),
): Promise<ChallengeVerdict> {
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

  // The proof is checked before the nonce is claimed, so a wrong answer costs
  // the caller nothing but the work: only an accepted proof spends its nonce.
  if (!isSolved(nonce, solution, DEFAULT_DIFFICULTY_BITS)) return "unsolved";

  /*
   * Claiming and checking in one statement, which is what makes "once" true.
   * The old set was read and then written, so two copies of the same proof
   * arriving together both passed — and being per process, the same proof
   * passed again on every other instance besides. Counting the nonce answers
   * both halves: the claim that returns 1 is the one that got there first.
   *
   * The row lives exactly as long as the nonce does. Any later replay is
   * refused as `expired` above, before this is reached at all.
   */
  try {
    const { hits } = await countInWindow(
      `${NONCE_KEY}${nonce}`,
      Math.max(1, Math.ceil((expiresAt - now) / 1_000)),
    );
    return hits > 1 ? "spent" : "ok";
  } catch (error) {
    // Fail open, as everywhere else here: the mutation this guards is about to
    // ask the same unreachable database for something far more important.
    unavailable("claim", error);
    return "ok";
  }
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
export async function resetBotChallenges() {
  await forgetWindows("bot_challenge.");
}
