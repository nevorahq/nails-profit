import { getResendWebhookSecret } from "@/env";
import { logEvent } from "@/lib/logger";
import {
  handleVerifiedResendWebhook,
} from "@/lib/resend-webhook";
import {
  verifyResendWebhook,
  type ResendWebhookHeaders,
} from "@/lib/resend-webhook-signature";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 128 * 1024;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const secret = getResendWebhookSecret();
  if (!secret) return json(404, { received: false });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json(413, { received: false });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json(413, { received: false });
  }

  const providerEventId = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!providerEventId || !timestamp || !signature) {
    return json(400, { received: false });
  }

  let payload: unknown;
  try {
    payload = verifyResendWebhook(
      rawBody,
      {
        "svix-id": providerEventId,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      } satisfies ResendWebhookHeaders,
      secret,
    );
  } catch {
    logEvent("warn", "notification.webhook_rejected", {}, { provider: "resend" });
    return json(400, { received: false });
  }

  const outcome = await handleVerifiedResendWebhook(payload, providerEventId);
  logEvent("info", "notification.webhook_received", {}, { provider: "resend", outcome });
  return json(200, { received: true });
}
