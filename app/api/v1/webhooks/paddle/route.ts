import { getPaddleWebhookSecret } from "@/env";
import { applyBillingEvent } from "@/lib/billing-subscription";
import { logEvent } from "@/lib/logger";
import { parsePaddleEvent, parsePaddleSignatureHeader, verifyPaddleWebhook } from "@/lib/paddle-webhook";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const secret = getPaddleWebhookSecret();
  if (!secret) return json(404, { received: false });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json(413, { received: false });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json(413, { received: false });
  }

  const signatureHeader = request.headers.get("paddle-signature");
  const parsedHeader = signatureHeader ? parsePaddleSignatureHeader(signatureHeader) : null;
  if (!parsedHeader || !verifyPaddleWebhook(rawBody, parsedHeader, secret)) {
    logEvent("warn", "billing.webhook_rejected", {}, { provider: "paddle" });
    return json(400, { received: false });
  }

  let payload: unknown = null;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    return json(400, { received: false });
  }

  const eventId = (payload as { event_id?: unknown } | null)?.event_id;
  const event = parsePaddleEvent(payload);
  const outcome =
    event && typeof eventId === "string" ? await applyBillingEvent(event, eventId) : "unmatched";

  logEvent("info", "billing.webhook_received", {}, { provider: "paddle", outcome });
  return json(200, { received: true });
}
