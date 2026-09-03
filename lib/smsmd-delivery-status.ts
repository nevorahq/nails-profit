import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, notLike, or } from "drizzle-orm";

import { notificationOutbox, notificationProviderEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { getSmsMdConfig, getSmsProviderName } from "@/env";
import { logEvent } from "@/lib/logger";
import { LOGGED_MESSAGE_ID_PREFIX, SMSMD_API_BASE } from "@/lib/notification-provider";

/**
 * Delivery statuses for sms.md, the pull counterpart of the webhook Resend
 * pushes at us.
 *
 * That webhook finds its way back to a row because the provider echoes
 * something of ours — the `tags` we set on the message. sms.md's delivery
 * callback carries only its own message id, the recipient's number and the
 * message text: nothing that says which organization the row belongs to, and
 * `withTenant` cannot be opened without one. Answering that would mean either
 * a lookup table outside the tenant boundary or a webhook route holding a
 * connection that bypasses RLS, and neither is worth a status column.
 *
 * So the status is fetched instead of awaited: the same cron that drains the
 * outbox already walks every tenant, and inside that walk `GET
 * /v3/messages/{id}` is an ordinary tenant-scoped read. It also keeps the
 * message text — which their callback would POST back to us, one-time codes
 * included — off this deployment entirely.
 */

/**
 * `GET /v3/messages/statuses` is documented as a static list: 1 Queued,
 * 2 Sent, 3 Delivered, 8 Unknown, 9 Undelivered, 10 Failed.
 *
 * 8 is deliberately unmapped. It means the platform never learned what
 * happened, and the honest record of that is no record — writing `failed`
 * would report a delivery failure we have not been told about, and
 * `delivered` a success nobody confirmed.
 */
const STATUS_MAP: Record<number, "accepted" | "sent" | "delivered" | "failed"> = {
  1: "accepted",
  2: "sent",
  3: "delivered",
  9: "failed",
  10: "failed",
};

/** Terminal for us: a row whose status can no longer change is not asked about again. */
const OPEN_STATUSES = ["accepted", "sent"] as const;

/**
 * How far back a message is still worth asking about. Their own delivery
 * reports stop at a terminal status, and a message that has not reached one
 * within a day is one the carrier is not going to resolve either.
 */
const POLL_WINDOW_HOURS = 24;

/** Rows per tenant per run — bounded because each one is its own HTTP request. */
const POLL_BATCH = 50;

export type StatusPollSummary = Readonly<{ checked: number; updated: number }>;

const EMPTY: StatusPollSummary = { checked: 0, updated: 0 };

type MessageStatusResponse = Readonly<{
  data?: Readonly<{
    status?: Readonly<{ id?: unknown }>;
    dateUpdated?: unknown;
    dateSent?: unknown;
  }>;
}>;

function asEventTime(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/**
 * One tenant's outstanding SMS, asked about once each.
 *
 * A failure that is about the credentials rather than about one message — a
 * token without `messages:read`, a rate limit — ends the pass instead of
 * repeating itself fifty times: the next run is five minutes away, and the
 * statuses are telemetry, not something a client is waiting for.
 */
export async function pollSmsMdDeliveryStatuses(input: {
  organizationId: string;
  now?: Date;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<StatusPollSummary> {
  if (getSmsProviderName() !== "smsmd") return EMPTY;

  const now = input.now ?? new Date();
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = getSmsMdConfig();

  const open = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ id: notificationOutbox.id, providerMessageId: notificationOutbox.providerMessageId })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.channel, "sms"),
          eq(notificationOutbox.status, "sent"),
          isNotNull(notificationOutbox.providerMessageId),
          /*
           * Only ids sms.md issued. A row sent while the provider was `log`
           * carries a fake id in that provider's own namespace, and asking
           * sms.md about one is a 404 against somebody's account — repeated
           * every run, because a 404 leaves the row open and it is selected
           * again. That is what happened on the pilot the day the provider was
           * switched: the queue still held rows from before the switch, and
           * their ids were polled for as long as the window kept them.
           */
          notLike(notificationOutbox.providerMessageId, `${LOGGED_MESSAGE_ID_PREFIX}%`),
          gte(notificationOutbox.sentAt, new Date(now.getTime() - POLL_WINDOW_HOURS * 3_600_000)),
          or(
            isNull(notificationOutbox.providerStatus),
            inArray(notificationOutbox.providerStatus, [...OPEN_STATUSES]),
          ),
        ),
      )
      .orderBy(asc(notificationOutbox.sentAt))
      .limit(input.limit ?? POLL_BATCH),
  );

  let checked = 0;
  let updated = 0;
  let unknownIds = 0;

  for (const row of open) {
    const providerMessageId = row.providerMessageId;
    if (!providerMessageId) continue;

    let response: Response;
    try {
      response = await fetchImpl(`${SMSMD_API_BASE}/messages/${encodeURIComponent(providerMessageId)}`, {
        headers: { "x-api-token": config.token },
      });
    } catch {
      // The platform did not answer. Nothing is known yet, and the row stays
      // open for the next run.
      break;
    }

    checked += 1;

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      logEvent(
        "warn",
        "notification.status_poll_refused",
        { organizationId: input.organizationId },
        { status: response.status },
      );
      break;
    }
    /*
     * An id the platform does not recognise. Nothing here can make it
     * recognisable, and no delivery outcome may be invented from it — 404 is
     * silence, not failure — so it is counted and said out loud instead of
     * disappearing into the `continue` below. The 24-hour window is what
     * finally stops it being asked about.
     */
    if (response.status === 404) {
      unknownIds += 1;
      continue;
    }
    if (!response.ok) continue;

    const body = (await response.json().catch(() => null)) as MessageStatusResponse | null;
    const statusId = body?.data?.status?.id;
    const providerStatus = typeof statusId === "number" ? STATUS_MAP[statusId] : undefined;
    if (!providerStatus) continue;

    const eventAt = asEventTime(body?.data?.dateUpdated ?? body?.data?.dateSent, now);
    const recorded = await record(input.organizationId, {
      notificationId: row.id,
      providerMessageId,
      providerStatus,
      eventAt,
      receivedAt: now,
    });
    if (recorded) updated += 1;
  }

  if (checked > 0) {
    logEvent(
      "info",
      "notification.status_polled",
      { organizationId: input.organizationId },
      { checked, updated, unknown_ids: unknownIds },
    );
  }

  // Loud, because the only healthy number here is zero: every one of these is a
  // request the provider had no reason to receive, and a run of them is how an
  // account gets its token pulled.
  if (unknownIds > 0) {
    logEvent(
      "warn",
      "notification.status_poll_unknown_ids",
      { organizationId: input.organizationId },
      { unknown_ids: unknownIds },
    );
  }

  return { checked, updated };
}

/**
 * The same two writes the webhook handlers make, and for the same reasons: an
 * event row that deduplicates on this message at this status, and a summary
 * on the outbox that only ever moves forward in time. Polling repeats what it
 * already knows by design — every run re-reads a message that has not reached
 * a terminal status — so the conflict below is the normal case, not the
 * exception.
 */
async function record(
  organizationId: string,
  input: Readonly<{
    notificationId: string;
    providerMessageId: string;
    providerStatus: "accepted" | "sent" | "delivered" | "failed";
    eventAt: Date;
    receivedAt: Date;
  }>,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const inserted = await tx
      .insert(notificationProviderEvents)
      .values({
        organizationId,
        notificationId: input.notificationId,
        providerEventId: `${input.providerMessageId}:${input.providerStatus}`,
        providerMessageId: input.providerMessageId,
        eventType: input.providerStatus,
        eventCreatedAt: input.eventAt,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing({ target: notificationProviderEvents.providerEventId })
      .returning({ id: notificationProviderEvents.id });
    if (inserted.length === 0) return false;

    await tx
      .update(notificationOutbox)
      .set({
        providerStatus: input.providerStatus,
        providerEventAt: input.eventAt,
        updatedAt: input.receivedAt,
      })
      .where(
        and(
          eq(notificationOutbox.id, input.notificationId),
          or(
            isNull(notificationOutbox.providerEventAt),
            lt(notificationOutbox.providerEventAt, input.eventAt),
          ),
        ),
      );

    return true;
  });
}
