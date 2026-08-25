import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared by Paddle and Lemon Squeezy: both sign a webhook with a plain
 * HMAC-SHA256 hex digest over some string derived from the raw body, checked
 * in constant time for the same reason `matchesToken` in
 * `lib/messaggio-webhook.ts` is — a comparison that returns on the first
 * mismatched byte leaks the secret one byte at a time.
 */
export function verifyHmacHex(signedContent: string, hexSignature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(signedContent).digest("hex");
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(hexSignature, "hex");
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
