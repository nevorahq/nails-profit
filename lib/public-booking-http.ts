import {
  challengeRequired,
  issueChallenge,
  recordSuspiciousActivity,
  verifyChallenge,
} from "@/lib/bot-challenge";
import { apiError, rateLimited, requestId } from "@/lib/http";
import { logEvent } from "@/lib/logger";
import { callerKey, checkRateLimit, type RateLimitRule } from "@/lib/rate-limit";

/**
 * The preamble every public endpoint shares: who is calling, whether they are
 * within their limit, and — once they have been refused enough times — whether
 * they have done the work section 7.9 asks a suspected bot for.
 *
 * `challenge: true` marks the endpoints that cost something to serve or to
 * abuse: holding a slot, creating a booking, asking for a code. Reads stay
 * unchallenged, because a client comparing times should never be asked to
 * compute anything, and the rate limits already bound what a scraper gets.
 */
export function publicRequest(
  request: Request,
  rule: RateLimitRule,
  bucket: string,
  options: { organizationId?: string | null; challenge?: boolean } = {},
) {
  const id = requestId(request);
  const caller = callerKey(request, null);
  const { organizationId = null, challenge = false } = options;

  const decision = checkRateLimit(`${bucket}:${caller}`, rule);
  if (!decision.allowed) {
    // A refusal is the signal, not the punishment: the count is what eventually
    // turns the challenge on for this caller.
    recordSuspiciousActivity(caller);
    return {
      id,
      caller,
      refused: rateLimited(id, decision.retryAfterSeconds, { organizationId, bucket }),
    };
  }

  if (challenge && challengeRequired(caller)) {
    const verdict = verifyChallenge(caller, request.headers.get("x-booking-challenge"));
    if (verdict !== "ok") {
      logEvent("warn", "security.challenge_required", { requestId: id, organizationId }, {
        bucket,
        verdict,
      });
      return {
        id,
        caller,
        refused: apiError(403, "CHALLENGE_REQUIRED", "Solve the challenge and retry", id, {
          // The nonce travels with the refusal, so a client needs one round trip
          // rather than two, and a browser can retry without a second screen.
          details: { ...issueChallenge(caller), reason: verdict },
        }),
      };
    }
  }

  return { id, caller, refused: null };
}

export function publicNotFound(id: string) {
  // Draft, paused, unknown and disabled are deliberately indistinguishable.
  return apiError(404, "BOOKING_PAGE_NOT_FOUND", "This booking page is not available", id);
}
