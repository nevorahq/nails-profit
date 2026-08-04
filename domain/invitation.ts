import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Invitation tokens follow the rule spec section 12.3 sets for public links:
 * a random one-time token, of which the database stores only a hash.
 *
 * The token carries its organization as a plaintext prefix — `{orgId}.{secret}`.
 * That is what lets the accept path stay inside row level security: the caller
 * is not a member yet, so there is no tenant context to set, and without the
 * prefix the row could not be found without disabling RLS for the lookup. The
 * prefix grants nothing on its own; authorization is the hash match on the
 * secret half, which is 256 bits of randomness.
 *
 * SHA-256 rather than Argon2id on purpose: this is a high-entropy random token,
 * not a human-chosen password, so there is nothing for a slow KDF to defend.
 */

const SECRET_BYTES = 32;

export const INVITATION_TTL_DAYS = 7;

export type InvitationToken = Readonly<{
  /** Shown to the inviter once; never stored. */
  token: string;
  tokenHash: string;
}>;

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createInvitationToken(organizationId: string): InvitationToken {
  const token = `${organizationId}.${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { token, tokenHash: hashInvitationToken(token) };
}

const TOKEN_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{20,})$/;

/**
 * Splits a token into the organization to scope the lookup to and the hash to
 * match. Returns null for anything malformed, so a junk token costs one regex
 * rather than a database round trip.
 */
export function parseInvitationToken(
  token: string,
): Readonly<{ organizationId: string; tokenHash: string }> | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  return { organizationId: match[1], tokenHash: hashInvitationToken(token.trim()) };
}

/** Constant-time comparison, for the rare path that compares hashes in Node. */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type StoredInvitationStatus = "pending" | "accepted" | "revoked";
export type EffectiveInvitationStatus = StoredInvitationStatus | "expired";

/**
 * Expiry is derived from `expires_at` rather than written into the row, so no
 * background job is needed to keep statuses honest.
 */
export function effectiveInvitationStatus(
  status: StoredInvitationStatus,
  expiresAt: Date,
  now: Date = new Date(),
): EffectiveInvitationStatus {
  if (status === "pending" && expiresAt.getTime() <= now.getTime()) return "expired";
  return status;
}

export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}
