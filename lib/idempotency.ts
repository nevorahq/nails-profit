import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { bookingIdempotencyKeys } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";

/**
 * Idempotency for booking mutations, roadmap section 7.5: "повторный запрос
 * возвращает исходный результат, а не создаёт вторую запись".
 *
 * Mobile networks retry, and a client tapping "confirm" twice on a slow
 * connection is not asking for two Tuesdays.
 *
 * The claim is written *before* the booking, inside the same transaction. A
 * second request with the same key blocks on the unique index until the first
 * commits or rolls back, which is what makes two simultaneous retries produce
 * one booking rather than two — a check that reads before it writes would let
 * both through.
 */
export type IdempotencyClaim =
  /** This request owns the key; carry on and record the result. */
  | Readonly<{ status: "claimed"; id: string }>
  /**
   * The same request was already answered; return that answer verbatim.
   *
   * `bookingId` for the mutations that produce one row, `result` for those that
   * do not: a bulk import that created 28 rows has no single row to point
   * at, and "created: 28" is the only honest replay of it.
   */
  | Readonly<{
      status: "replay";
      bookingId: string | null;
      result: Record<string, unknown> | null;
    }>
  /** The key was used for something else. Answering would hand over the wrong booking. */
  | Readonly<{ status: "conflict" }>;

/**
 * A fingerprint of what was asked, so that reusing a key for a different
 * request is refused instead of silently answering with someone else's booking.
 * Keys are sorted, so field order in the JSON cannot change the digest.
 */
export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export async function claimIdempotencyKey(
  tx: TenantTransaction,
  input: { organizationId: string; scope: string; key: string; fingerprint: string },
): Promise<IdempotencyClaim> {
  const [claimed] = await tx
    .insert(bookingIdempotencyKeys)
    .values({
      organizationId: input.organizationId,
      scope: input.scope,
      idempotencyKey: input.key,
      requestFingerprint: input.fingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: bookingIdempotencyKeys.id });

  if (claimed) return { status: "claimed", id: claimed.id };

  const [existing] = await tx
    .select({
      fingerprint: bookingIdempotencyKeys.requestFingerprint,
      bookingId: bookingIdempotencyKeys.bookingId,
      result: bookingIdempotencyKeys.result,
    })
    .from(bookingIdempotencyKeys)
    .where(
      and(
        eq(bookingIdempotencyKeys.scope, input.scope),
        eq(bookingIdempotencyKeys.idempotencyKey, input.key),
      ),
    )
    .limit(1);

  if (!existing) return { status: "conflict" };
  return existing.fingerprint === input.fingerprint
    ? { status: "replay", bookingId: existing.bookingId, result: existing.result ?? null }
    : { status: "conflict" };
}

export async function recordIdempotentResult(tx: TenantTransaction, claimId: string, bookingId: string) {
  await tx
    .update(bookingIdempotencyKeys)
    .set({ bookingId })
    .where(eq(bookingIdempotencyKeys.id, claimId));
}

/**
 * The counts a retry should be answered with, for mutations whose result is not
 * one row. Written in the same transaction as the work, so a retry either sees
 * the whole thing or claims the key itself.
 */
export async function recordIdempotentOutcome(
  tx: TenantTransaction,
  claimId: string,
  result: Record<string, unknown>,
) {
  await tx
    .update(bookingIdempotencyKeys)
    .set({ result })
    .where(eq(bookingIdempotencyKeys.id, claimId));
}
