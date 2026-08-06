import { apiError, rateLimited, requestId } from "@/lib/http";
import { callerKey, checkRateLimit, type RateLimitRule } from "@/lib/rate-limit";

export function publicRequest(
  request: Request,
  rule: RateLimitRule,
  bucket: string,
  organizationId?: string | null,
) {
  const id = requestId(request);
  const decision = checkRateLimit(`${bucket}:${callerKey(request, null)}`, rule);
  return {
    id,
    refused: decision.allowed
      ? null
      : rateLimited(id, decision.retryAfterSeconds, { organizationId, bucket }),
  };
}

export function publicNotFound(id: string) {
  // Draft, paused, unknown and disabled are deliberately indistinguishable.
  return apiError(404, "BOOKING_PAGE_NOT_FOUND", "This booking page is not available", id);
}
