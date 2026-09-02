import { getPaddleWebhookSecret, isPaddleWebhookIpAllowlistEnabled } from "@/env";
import { applyBillingEvent } from "@/lib/billing-subscription";
import { clientIpFromHeaders, ipInAllowlist } from "@/lib/ip-allowlist";
import { logEvent } from "@/lib/logger";
import { getPaddleIpAllowlist } from "@/lib/paddle-ips";
import { parsePaddleEvent, parsePaddleSignatureHeader, verifyPaddleWebhook } from "@/lib/paddle-webhook";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Paddle sends webhooks from a small published set of addresses. When the
 * allowlist cannot be fetched right now and nothing is cached, the request is
 * let through to the signature check rather than dropped — a Paddle-side outage
 * of that one endpoint must not stop real deliveries — but the gap is logged.
 */
async function rejectDisallowedIp(request: Request): Promise<Response | null> {
  const allowlist = await getPaddleIpAllowlist();
  if (!allowlist) {
    logEvent("warn", "billing.webhook_ip_allowlist_unavailable", {}, { provider: "paddle" });
    return null;
  }
  const ip = clientIpFromHeaders(request.headers);
  if (ip && ipInAllowlist(ip, allowlist)) return null;

  logEvent("warn", "billing.webhook_rejected", {}, { provider: "paddle", reason: "ip" });
  return json(403, { received: false });
}

export async function POST(request: Request) {
  const secret = getPaddleWebhookSecret();
  if (!secret) return json(404, { received: false });

  if (isPaddleWebhookIpAllowlistEnabled()) {
    const rejection = await rejectDisallowedIp(request);
    if (rejection) return rejection;
  }

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
