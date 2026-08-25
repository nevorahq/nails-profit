import { timingSafeEqual } from "node:crypto";

import { getMessaggioWebhookToken } from "@/env";
import { logEvent } from "@/lib/logger";
import { handleVerifiedMessaggioWebhook } from "@/lib/messaggio-webhook";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Messaggio's delivery callback (API documentation, section 3), roadmap
 * section 7.7's second channel — a JSON POST, unlike Resend's.
 *
 * Unlike Resend there is no request signature to verify — the documentation
 * describes none — so the token in the URL itself is what stands in for one:
 * it is the last segment of the callback address registered in the
 * Messaggio account's own project settings (or passed per-message as
 * `options.dlr_callback_url`), and a request that does not know it gets the
 * same 404 the route would answer if it were disabled entirely.
 * Constant-time comparison, same reasoning as the bot-challenge token check:
 * a response that took longer for a closer guess would leak the secret one
 * byte at a time.
 */
function matchesToken(expected: string, supplied: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function acknowledged() {
  // Messaggio resends for 24h on anything but a 200; the body just has to be
  // present, its content is not inspected.
  return new Response("OK", { status: 200, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const secret = getMessaggioWebhookToken();
  const { token } = await params;
  if (!secret || !matchesToken(secret, token)) {
    return new Response(null, { status: 404 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  let body: unknown = null;
  try {
    body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    // Malformed JSON validates to "ignored" the same way an unmapped status
    // does — Messaggio still gets its 200 so it stops retrying a request it
    // is never going to send correctly.
  }

  const outcome = await handleVerifiedMessaggioWebhook(body);
  logEvent("info", "notification.webhook_received", {}, { provider: "messaggio", outcome });
  return acknowledged();
}
