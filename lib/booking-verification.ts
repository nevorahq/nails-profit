import { and, eq, gt } from "drizzle-orm";

import { bookingHolds, bookingVerifications } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { normalizePhone } from "@/domain/phone";
import {
  generateVerificationCode,
  hashVerificationCode,
  MAX_VERIFICATION_ATTEMPTS,
  verificationCodeMatches,
} from "@/domain/verification-code";
import { enqueueVerificationNotification } from "@/lib/booking-notifications";

/**
 * Proving that the contact belongs to whoever is booking, roadmap section 7.2
 * step 7 and section 7.9.
 *
 * Without it the public page writes to the client list on the word of an
 * anonymous visitor: a phone number typed by anyone matches an existing client
 * and rewrites their name, their email and their language. The code is what
 * turns "someone typed this number" into "someone holding this number asked
 * for this appointment".
 *
 * The challenge hangs off the hold, so it expires with the slot it was issued
 * for, and it carries the contact it was sent to — a code confirmed for one
 * number cannot be used to book under a different one.
 *
 * Every answer is deliberately uninformative about who exists: section 7.9
 * requires that "ответы verification не позволяют определить, существует ли
 * телефон/email", so requesting a code looks identical for a first-time client
 * and for a returning one.
 */
export type VerificationRequestInput = Readonly<{
  organizationId: string;
  holdId: string;
  phone: string;
  email?: string | null;
  locale: string;
  ttlMinutes: number;
  now: Date;
}>;

export type VerificationChallenge = Readonly<{
  channel: "sms" | "email";
  expiresAt: Date;
}>;

/**
 * Issues (or replaces) the code for a hold.
 *
 * SMS when there is a phone, which for this flow is always: the public form
 * requires one and an email is optional. Replacing rather than adding, because
 * two live codes for one slot means the older SMS — the one that arrived
 * first — silently stops working.
 */
export async function requestVerification(
  tx: TenantTransaction,
  input: VerificationRequestInput,
): Promise<VerificationChallenge | null> {
  const phone = normalizePhone(input.phone);
  const destination = phone ?? input.email?.trim().toLowerCase() ?? null;
  if (!destination) return null;
  const channel = phone ? "sms" : "email";

  const code = generateVerificationCode();
  const expiresAt = new Date(input.now.getTime() + input.ttlMinutes * 60_000);

  const [verification] = await tx
    .insert(bookingVerifications)
    .values({
      organizationId: input.organizationId,
      holdId: input.holdId,
      channel,
      destination,
      locale: input.locale,
      codeHash: hashVerificationCode(input.holdId, code),
      expiresAt,
      attempts: 0,
      verifiedAt: null,
    })
    .onConflictDoUpdate({
      target: bookingVerifications.holdId,
      set: {
        channel,
        destination,
        locale: input.locale,
        codeHash: hashVerificationCode(input.holdId, code),
        expiresAt,
        attempts: 0,
        verifiedAt: null,
        updatedAt: input.now,
      },
    })
    .returning();

  await enqueueVerificationNotification(tx, {
    organizationId: input.organizationId,
    verificationId: verification.id,
    channel,
    code,
    // A resend is a new message, not a duplicate of the first one.
    occurrence: String(input.now.getTime()),
  });

  return { channel, expiresAt };
}

export type VerificationOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "unknown" | "expired" | "locked" | "mismatch" }>;

export async function confirmVerification(
  tx: TenantTransaction,
  input: { holdId: string; code: string; now: Date },
): Promise<VerificationOutcome> {
  const [verification] = await tx
    .select()
    .from(bookingVerifications)
    .where(eq(bookingVerifications.holdId, input.holdId))
    .limit(1);
  if (!verification) return { ok: false, reason: "unknown" };
  if (verification.expiresAt <= input.now) return { ok: false, reason: "expired" };
  if (verification.attempts >= MAX_VERIFICATION_ATTEMPTS) return { ok: false, reason: "locked" };

  if (!verificationCodeMatches(input.holdId, input.code, verification.codeHash)) {
    // Counted before the answer is returned, so a client guessing codes runs
    // out of attempts whether or not they wait for the response.
    await tx
      .update(bookingVerifications)
      .set({ attempts: verification.attempts + 1, updatedAt: input.now })
      .where(eq(bookingVerifications.id, verification.id));
    return { ok: false, reason: "mismatch" };
  }

  await tx
    .update(bookingVerifications)
    .set({ verifiedAt: input.now, updatedAt: input.now })
    .where(eq(bookingVerifications.id, verification.id));

  return { ok: true };
}

/**
 * Whether the contact on a booking request has been proven for this hold.
 *
 * The destination is compared, not merely the presence of a verified row: a
 * code confirmed for one number must not authorise a booking submitted with
 * another.
 */
export async function isContactVerified(
  tx: TenantTransaction,
  input: { holdId: string; normalizedPhone: string; email: string | null; now: Date },
) {
  const [verification] = await tx
    .select({
      destination: bookingVerifications.destination,
      verifiedAt: bookingVerifications.verifiedAt,
    })
    .from(bookingVerifications)
    .where(
      and(
        eq(bookingVerifications.holdId, input.holdId),
        gt(bookingVerifications.expiresAt, input.now),
      ),
    )
    .limit(1);
  if (!verification?.verifiedAt) return false;

  return (
    verification.destination === input.normalizedPhone ||
    (input.email !== null && verification.destination === input.email)
  );
}

/** The hold a public token points at, when it is still live. */
export async function liveHoldFor(tx: TenantTransaction, tokenHash: string, now: Date) {
  const [hold] = await tx
    .select()
    .from(bookingHolds)
    .where(
      and(
        eq(bookingHolds.tokenHash, tokenHash),
        eq(bookingHolds.status, "active"),
        gt(bookingHolds.expiresAt, now),
      ),
    )
    .limit(1);

  return hold ?? null;
}
