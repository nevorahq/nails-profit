import { bookingAccessTokens } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { createBookingToken } from "@/domain/booking-token";
import { getPublicAppUrl } from "@/env";

/**
 * The link a client manages a booking with, roadmap section 7.2.
 *
 * Issued in one place because three call sites need one: the endpoint that
 * creates a booking, the dispatcher that puts a link into every message, and
 * the staff action that hands out a fresh one when a client has lost theirs.
 *
 * A new token per message rather than a stored one, because only the hash is
 * kept — deliberately, section 7.9 — and a hash cannot be put in an SMS. Older
 * links are left alone: revoking them would break the page the client may have
 * open at that moment, and each one expires on its own.
 */
const MANAGE_TOKEN_TTL_DAYS = 180;

export async function issueManageLink(
  tx: TenantTransaction,
  input: { organizationId: string; bookingId: string; now: Date },
) {
  const token = createBookingToken(input.organizationId, "manage");
  await tx.insert(bookingAccessTokens).values({
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    purpose: "manage",
    tokenHash: token.tokenHash,
    expiresAt: new Date(input.now.getTime() + MANAGE_TOKEN_TTL_DAYS * 24 * 60 * 60_000),
  });

  return { token: token.token, path: managePath(token.token), url: manageUrl(token.token) };
}

export function managePath(token: string) {
  return `/booking/${token}`;
}

export function manageUrl(token: string) {
  return `${getPublicAppUrl()}${managePath(token)}`;
}

export function bookingPageUrl(slug: string) {
  return `${getPublicAppUrl()}/book/${slug}`;
}
