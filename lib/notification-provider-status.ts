import { and, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";

import { notificationOutbox } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";

/**
 * When a provider's word about a message is allowed to replace the last one.
 *
 * The outbox carries a summary of what the provider last said; the full history
 * lives in `notification_provider_event`. Providers do not promise to deliver
 * their events in order — Resend says so outright, and a poll can read a status
 * that a webhook has already superseded — so the summary only ever moves
 * forward, and provider time is what decides which way forward is.
 *
 * Which was almost enough. sms.md marked five messages «Отклонено» without
 * touching their `dateUpdated`, so the failure arrived carrying the same
 * timestamp as the `accepted` already stored. `<` is false for equal times, the
 * update matched no rows, and four appointments' worth of messages sat at
 * `accepted` — recorded as failures in the event table, reported as accepted
 * everywhere anyone looks. Nothing retries it either: the event id is taken, so
 * the next poll inserts nothing and never reaches the summary again.
 *
 * So an equal timestamp is no longer silence. It cannot be ordered by time, so
 * it is ordered by whether the message has finished: an outcome may replace an
 * unfinished status, and nothing may replace an outcome. Transitions between
 * two unfinished statuses on the same second stay dropped — `accepted` giving
 * way to `sent` at the same instant is detail, and the event table has it.
 */

/**
 * Statuses that settle a message. Everything else — `accepted`, `sent`,
 * `delayed` — means somebody is still holding it.
 *
 * The same five `OUTCOME_STATUSES` in `scripts/booking-metrics-core.mjs` counts
 * as finished, for the same reason and from the same list.
 */
export const TERMINAL_PROVIDER_STATUSES = [
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const;

export type ProviderStatus = (typeof notificationOutbox.providerStatus.enumValues)[number];

const IN_FLIGHT_PROVIDER_STATUSES = notificationOutbox.providerStatus.enumValues.filter(
  (status) => !(TERMINAL_PROVIDER_STATUSES as readonly string[]).includes(status),
);

function isTerminal(status: ProviderStatus) {
  return (TERMINAL_PROVIDER_STATUSES as readonly string[]).includes(status);
}

/** The condition above, as SQL: strictly newer, or an outcome breaking a tie. */
function mayAdvance(status: ProviderStatus, eventAt: Date): SQL | undefined {
  const newer = or(
    isNull(notificationOutbox.providerEventAt),
    lt(notificationOutbox.providerEventAt, eventAt),
  );
  if (!isTerminal(status)) return newer;

  return or(
    newer,
    and(
      eq(notificationOutbox.providerEventAt, eventAt),
      inArray(notificationOutbox.providerStatus, IN_FLIGHT_PROVIDER_STATUSES),
    ),
  );
}

/**
 * Move the outbox summary to what the provider now says, if it may move.
 *
 * Deliberately separate from writing the event that prompted it, and called
 * whether or not that event was new. A summary left behind by an earlier bug —
 * or by an event this deployment recorded before it knew how to read it — is
 * repaired on the next poll rather than frozen by the deduplication that was
 * meant to protect it.
 *
 * Returns whether the summary actually changed, which is the number worth
 * reporting: an event nobody had seen that moves nothing is not progress.
 */
export async function advanceProviderStatus(
  tx: TenantTransaction,
  input: Readonly<{
    notificationId: string;
    providerStatus: ProviderStatus;
    eventAt: Date;
    receivedAt: Date;
  }>,
): Promise<boolean> {
  const moved = await tx
    .update(notificationOutbox)
    .set({
      providerStatus: input.providerStatus,
      providerEventAt: input.eventAt,
      updatedAt: input.receivedAt,
    })
    .where(and(eq(notificationOutbox.id, input.notificationId), mayAdvance(input.providerStatus, input.eventAt)))
    .returning({ id: notificationOutbox.id });

  return moved.length > 0;
}
