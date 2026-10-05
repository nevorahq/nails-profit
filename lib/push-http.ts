import { z } from "zod";

import { can } from "@/domain/rbac";
import { apiError, rateLimited } from "@/lib/http";
import { getActiveMembership, type ActiveMembership } from "@/lib/membership";
import { callerKey, checkRateLimit, type RateLimitRule } from "@/lib/rate-limit";

/**
 * The preamble the push endpoints share.
 *
 * Who may hold a device: anybody who can read the calendar, because what a
 * push says is a line of the calendar — the same gate as the bell. The CSRF
 * check is inside `getActiveMembership`, as for every other route; an owner
 * previewing a colleague is refused writes by `proxy.ts` before this runs, so
 * nobody subscribes a phone in somebody else's name.
 *
 * The bucket is the route's own, not the person's: a person flipping the switch
 * must not spend the allowance their avatar uploads count against.
 */
export async function pushCaller(
  request: Request,
  id: string,
  rule: RateLimitRule | null,
  bucket: string,
): Promise<Readonly<{ ok: true; actor: ActiveMembership }> | Readonly<{ ok: false; response: Response }>> {
  const caller = await getActiveMembership();
  if (!caller.session) {
    return { ok: false, response: apiError(401, "UNAUTHENTICATED", "Authentication is required", id) };
  }
  if (!caller.membership) {
    return {
      ok: false,
      response: apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id),
    };
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "read")) {
    return { ok: false, response: apiError(403, "FORBIDDEN", "This role has no notifications", id) };
  }

  if (rule) {
    const limit = await checkRateLimit(`${bucket}:${callerKey(request, actor.userId)}`, rule);
    if (!limit.allowed) {
      return {
        ok: false,
        response: rateLimited(id, limit.retryAfterSeconds, {
          bucket,
          organizationId: actor.organizationId,
          userId: actor.userId,
        }),
      };
    }
  }

  return { ok: true, actor };
}

/**
 * A push endpoint as browsers hand it over: an https URL at the push service.
 * Anything else — `http:`, a path, a URL inside this site — is somebody making
 * the server send requests where they choose.
 */
export const endpointSchema = z
  .url({ protocol: /^https$/ })
  .max(2_048);

/** URL-safe base64, the encoding `PushSubscription.toJSON()` uses for both keys. */
const base64url = (max: number) => z.string().regex(/^[A-Za-z0-9_-]+=*$/).min(16).max(max);

export const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  keys: z.object({ p256dh: base64url(200), auth: base64url(64) }),
});

export const deviceSchema = z.object({ endpoint: endpointSchema });
