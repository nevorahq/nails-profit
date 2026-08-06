import { createHash } from "node:crypto";

/**
 * The work a caller does to prove it is worth answering, roadmap section 7.9:
 * "после порога подозрительной активности включается bot challenge".
 *
 * Proof of work rather than a CAPTCHA vendor, and the reason is not
 * squeamishness about vendors. A CAPTCHA is a third party in the middle of a
 * booking flow that has to work on a 360 px screen in three languages, it sends
 * the client's address and behaviour to someone the studio never chose, and
 * Entry Gate 7 has not chosen one. This costs an attacker a measurable amount
 * of CPU per attempt and costs an ordinary client a fraction of a second, which
 * is the property that actually matters: it makes a loop expensive without
 * making a booking hard.
 *
 * It is not a defence against a determined attacker with a rented machine, and
 * it is not meant to be — the rate limits, the hold TTL and the verification
 * code are. This is what makes a cheap flood stop being cheap.
 */

/** Sixteen bits: about 65 000 hashes, well under a second in a browser. */
export const DEFAULT_DIFFICULTY_BITS = 16;

export function digestOf(nonce: string, solution: string): Buffer {
  return createHash("sha256").update(`${nonce}:${solution}`, "utf8").digest();
}

/**
 * Whether a digest starts with `bits` zero bits.
 *
 * Bits rather than leading zero characters, so difficulty can be raised in
 * steps smaller than a factor of sixteen.
 */
export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (digest[index] !== 0) return false;
  }

  const remainder = bits % 8;
  if (remainder === 0) return true;
  return (digest[wholeBytes] >> (8 - remainder)) === 0;
}

export function isSolved(nonce: string, solution: string, bits: number): boolean {
  return hasLeadingZeroBits(digestOf(nonce, solution), bits);
}

/**
 * Finds a solution. The browser runs the same loop; this exists so tests and
 * scripts do not have to reimplement it and drift from what is verified.
 */
export function solveChallenge(nonce: string, bits: number, limit = 5_000_000): string | null {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const solution = String(attempt);
    if (isSolved(nonce, solution, bits)) return solution;
  }
  return null;
}
