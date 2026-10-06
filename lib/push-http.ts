import { z } from "zod";

import { can } from "@/domain/rbac";
import { apiError, rateLimited } from "@/lib/http";
import { getActiveMembership, type ActiveMembership } from "@/lib/membership";
import { checkRateLimit, rateLimitKey, type RateLimitRule } from "@/lib/rate-limit";

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
    const limit = await checkRateLimit(rateLimitKey(bucket, request, actor.userId), rule);
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
 * The push services browsers actually use: Chrome, Edge and Android (FCM),
 * Firefox (Mozilla autopush), Safari on macOS and iOS (Apple), and Edge's own
 * WNS. A suffix of the host, so a regional or numbered host of the same service
 * is still one of them.
 */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
] as const;

export function isPushServiceHost(host: string): boolean {
  const name = host.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((known) => name === known || name.endsWith(`.${known}`));
}

/**
 * A push endpoint as browsers hand it over: an https URL at a push service.
 * The server will later POST to whatever is stored here, so anything else — an
 * internal address, a URL inside this site, somebody's own collector — is a
 * caller choosing where this server sends requests, and is refused.
 */
export const endpointSchema = z
  .url({ protocol: /^https$/ })
  .max(2_048)
  // Zod runs this even after `url` refused the value, so it must not throw on
  // a string that is not a URL at all.
  .refine((value) => URL.canParse(value) && isPushServiceHost(new URL(value).hostname), "Not a known push service");

/** URL-safe base64, the encoding `PushSubscription.toJSON()` uses for both keys. */
const base64url = (max: number) => z.string().regex(/^[A-Za-z0-9_-]+=*$/).min(16).max(max);

export const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  keys: z.object({ p256dh: base64url(200), auth: base64url(64) }),
});

export const deviceSchema = z.object({ endpoint: endpointSchema });
