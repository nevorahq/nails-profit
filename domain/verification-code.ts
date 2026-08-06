import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The one-time code that proves a contact belongs to whoever is booking,
 * roadmap section 7.2 step 7.
 *
 * Six digits rather than a link, because the contact being proven is usually a
 * phone: a code can be read out of an SMS and typed into the form that is
 * already open, while a link opens a second browser session that knows nothing
 * about the hold.
 *
 * The code is bound to its hold in the hash. Section 7.9 requires verification
 * tokens to be purpose-bound, and without the binding a code obtained for a
 * slot the visitor was allowed to hold would open any other slot they later
 * guessed the hold for.
 */
export const VERIFICATION_CODE_LENGTH = 6;

/** Five wrong codes and the challenge is spent; a new code has to be requested. */
export const MAX_VERIFICATION_ATTEMPTS = 5;

export function generateVerificationCode(): string {
  // randomInt, not Math.random: this is a credential for the duration of a
  // booking, and a predictable one is no credential at all.
  return String(randomInt(0, 10 ** VERIFICATION_CODE_LENGTH)).padStart(
    VERIFICATION_CODE_LENGTH,
    "0",
  );
}

export function hashVerificationCode(holdId: string, code: string): string {
  return createHash("sha256").update(`verify:${holdId}:${code}`, "utf8").digest("hex");
}

/** Digits only, so "123 456" and "123-456" are the code the client was sent. */
export function normalizeVerificationCode(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  return digits.length === VERIFICATION_CODE_LENGTH ? digits : null;
}

export function verificationCodeMatches(holdId: string, code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashVerificationCode(holdId, code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}
