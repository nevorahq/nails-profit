/**
 * When a transactional message is tried again, and when it stops being tried —
 * roadmap section 7.7: "Scheduler отправляет сообщения идемпотентно, повторяет
 * временные ошибки с exponential backoff и переводит исчерпанные попытки в
 * `dead_letter`".
 *
 * Pure arithmetic on purpose. The dispatcher that uses it needs a database, a
 * provider and a clock; the policy it enforces needs none of the three, and the
 * cases worth being sure about — the fifth attempt, the cap, a reminder for an
 * appointment that starts sooner than the reminder interval — are exactly the
 * ones that are painful to reproduce with all three attached.
 */

/** The fifth failure is the last one; after it the row is a dead letter. */
export const MAX_DELIVERY_ATTEMPTS = 5;

const FIRST_RETRY_SECONDS = 60;
const RETRY_FACTOR = 5;
/** An hour: past this, retrying faster stops helping a provider that is down. */
const MAX_RETRY_SECONDS = 3_600;

/**
 * How long to wait after `attempt` failures: one minute, five, twenty-five,
 * then an hour.
 *
 * Growing rather than fixed because the two failures worth distinguishing look
 * identical from here — a provider that blipped answers on the first retry, a
 * provider that is down would take the whole queue's retries with it — and
 * spacing them out is what keeps the second from becoming a self-inflicted
 * flood.
 */
export function retryDelaySeconds(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(FIRST_RETRY_SECONDS * RETRY_FACTOR ** exponent, MAX_RETRY_SECONDS);
}

export type DeliveryDecision =
  | Readonly<{ status: "retry"; nextAttemptAt: Date }>
  | Readonly<{ status: "dead_letter" }>;

/**
 * What happens to a message that has just failed for the `attempt`-th time.
 *
 * A permanent failure — an address the provider rejects outright — is not
 * retried at all: repeating a request that cannot succeed spends the queue on
 * a message that will never arrive.
 */
export function decideAfterFailure(
  attempt: number,
  retryable: boolean,
  now: Date,
): DeliveryDecision {
  if (!retryable || attempt >= MAX_DELIVERY_ATTEMPTS) return { status: "dead_letter" };
  return {
    status: "retry",
    nextAttemptAt: new Date(now.getTime() + retryDelaySeconds(attempt) * 1_000),
  };
}

/**
 * When to remind a client, or `null` when there is no useful moment left.
 *
 * Section 7.7 makes the interval configurable and defaults it to 24 hours. A
 * booking made two hours before it starts has no such moment: sending the
 * reminder immediately would be a second confirmation, not a reminder, and
 * sending it in the past is not a thing a scheduler can do.
 */
export function reminderTimeFor(
  startsAt: Date,
  leadMinutes: number,
  now: Date,
): Date | null {
  if (leadMinutes <= 0) return null;
  const at = new Date(startsAt.getTime() - leadMinutes * 60_000);
  return at.getTime() > now.getTime() ? at : null;
}
