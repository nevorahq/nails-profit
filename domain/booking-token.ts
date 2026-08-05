import { createHash, randomBytes } from "node:crypto";

/**
 * Tokens for holds and, later, for the links a client manages a booking with —
 * roadmap section 7.9: "access/verification tokens случайны, ограничены по
 * purpose/TTL и хранятся только как hash".
 *
 * The same shape as an invitation token and for the same reason: the
 * organization travels in the clear so the lookup can be scoped before any
 * secret is compared, and only the hash is ever written down. What is different
 * is the purpose — a token minted to hold a slot must not be usable to open a
 * booking, so the purpose is hashed in with the secret rather than trusted from
 * a column beside it.
 */
export const bookingTokenPurposes = ["hold", "manage", "verify"] as const;
export type BookingTokenPurpose = (typeof bookingTokenPurposes)[number];

const SECRET_BYTES = 32;

export type BookingToken = Readonly<{
  /** Returned to the browser once and never stored. */
  token: string;
  tokenHash: string;
}>;

export function hashBookingToken(token: string, purpose: BookingTokenPurpose): string {
  return createHash("sha256").update(`${purpose}:${token}`, "utf8").digest("hex");
}

export function createBookingToken(organizationId: string, purpose: BookingTokenPurpose): BookingToken {
  const token = `${organizationId}.${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { token, tokenHash: hashBookingToken(token, purpose) };
}

const TOKEN_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{20,})$/;

/**
 * Splits a token into the organization to scope the lookup to and the hash to
 * match. Malformed input costs one regex rather than a database round trip, and
 * is indistinguishable from an unknown token in the response.
 */
export function parseBookingToken(
  token: string,
  purpose: BookingTokenPurpose,
): Readonly<{ organizationId: string; tokenHash: string }> | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  return { organizationId: match[1], tokenHash: hashBookingToken(token.trim(), purpose) };
}
