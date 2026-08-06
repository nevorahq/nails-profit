import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { getOpsApiToken } from "@/env";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { dispatchDueNotifications } from "@/lib/notification-dispatch";
import { logEvent } from "@/lib/logger";

/**
 * The job entry point for the notification outbox, roadmap section 7.7.
 *
 * Sending needs what only the application has — the message catalogue in three
 * languages, the location's timezone, and a freshly minted manage link — so the
 * scheduler asks the application to drain one tenant's queue rather than
 * reimplementing all three in a shell script against the tables.
 *
 * It authenticates with a shared secret, not a session: the caller is cron, and
 * a cron job holding a member's cookie would be an account nobody rotates. With
 * `OPS_API_TOKEN` unset the endpoint does not exist at all, which is the state
 * every deployment that has not set up the job should be in.
 *
 * Scoped to one organization per call on purpose. A cross-tenant sweep inside
 * the application would need a connection that bypasses RLS, and that
 * connection is exactly what the tenant boundary is built to avoid handing to
 * request-serving code.
 */
const bodySchema = z.object({
  organization_id: z.uuid(),
  limit: z.int().min(1).max(100).optional(),
});

function tokenMatches(supplied: string, expected: string) {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const expected = getOpsApiToken();
  if (!expected) {
    return apiError(404, "NOT_FOUND", "No such endpoint", id);
  }

  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!tokenMatches(supplied, expected)) {
    logEvent("warn", "ops.unauthorized", { requestId: id }, { endpoint: "notifications" });
    return apiError(401, "UNAUTHENTICATED", "A valid operator token is required", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const summary = await dispatchDueNotifications({
    organizationId: parsed.data.organization_id,
    limit: parsed.data.limit,
  });

  return apiSuccess(
    {
      claimed: summary.claimed,
      sent: summary.sent,
      retried: summary.retried,
      dead_lettered: summary.deadLettered,
    },
    id,
  );
}
