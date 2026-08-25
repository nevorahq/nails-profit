import { getLemonSqueezyWebhookSecret } from "@/env";
import { applyBillingEvent } from "@/lib/billing-subscription";
import { parseLemonSqueezyEvent, verifyLemonSqueezyWebhook } from "@/lib/lemon-squeezy-webhook";
import { logEvent } from "@/lib/logger";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const secret = getLemonSqueezyWebhookSecret();
  if (!secret) return json(404, { received: false });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json(413, { received: false });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json(413, { received: false });
  }

  const signature = request.headers.get("x-signature");
  if (!signature || !verifyLemonSqueezyWebhook(rawBody, signature, secret)) {
    logEvent("warn", "billing.webhook_rejected", {}, { provider: "lemon_squeezy" });
    return json(400, { received: false });
  }

  let payload: unknown = null;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    return json(400, { received: false });
  }

  // No separate event-id field in Lemon Squeezy's payload; the signature
  // itself is a valid idempotency key since it is a deterministic HMAC of the
  // raw body — a true resend has the same body and therefore the same
  // signature.
  const event = parseLemonSqueezyEvent(payload);
  const outcome = event ? await applyBillingEvent(event, signature) : "unmatched";

  logEvent("info", "billing.webhook_received", {}, { provider: "lemon_squeezy", outcome });
  return json(200, { received: true });
}
