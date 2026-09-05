import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lt, notLike, or } from "drizzle-orm";

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
 * `GET /v3/messages/statuses` answers 1 Queued, 2 Sent, 3 Delivered, 8 Unknown,
 * 9 Undelivered, 10 Failed — and their own specification says that list is
 * filtered: it "hides Resend/In Queue", which the legacy `GET /v1/message/status`
 * spells out as 4 «Повторная отправка» (the send failed in a way that allows
 * another attempt) and 5 «У оператора» (handed to the carrier, waiting there).
 * Both occur in their production data.
 *
 * They were missing here, and a status this map does not know is skipped in
 * silence by the loop below — the row keeps whatever it had, and the next run
 * asks again and skips again. So 5 is `sent`, which is what our vocabulary
 * calls a message the carrier now holds, and 4 is `delayed`, the enum value
 * that exists for exactly this: not delivered, not failed, being tried again.
 *
 * 8 stays deliberately unmapped. It means the platform never learned what
 * happened, and the honest record of that is no record — writing `failed`
 * would report a delivery failure we have not been told about, and
 * `delivered` a success nobody confirmed.
 */
type PolledStatus = "accepted" | "sent" | "delivered" | "delayed" | "failed";

const STATUS_MAP: Record<number, PolledStatus> = {
  1: "accepted",
  2: "sent",
  3: "delivered",
  4: "delayed",
  5: "sent",
  9: "failed",
  10: "failed",
};

/**
 * Terminal for us: a row whose status can no longer change is not asked about
 * again. `delayed` belongs here beside the other two — a message their platform
 * is about to retry has not finished, and leaving it out would freeze the row
 * at the one status that says it is still moving.
 */
const OPEN_STATUSES = ["accepted", "sent", "delayed"] as const;

/** Their «Unknown»: the platform saying it never found out. Not a gap in the map. */
const UNRESOLVED_STATUS_ID = 8;

/**
 * How far back a message is still worth asking about. Their own delivery
 * reports stop at a terminal status, and a message that has not reached one
 * within a day is one the carrier is not going to resolve either.
 *
 * Exported because giving up has to be visible somewhere else: the metrics
 * report counts rows that fell out of this window without an outcome, and the
 * two numbers have to mean the same day. See `PROVIDER_CONFIRMATION_WINDOW_HOURS`
 * in `scripts/booking-metrics-core.mjs`, which a test pins to this one.
 */
export const POLL_WINDOW_HOURS = 24;

/** Rows per tenant per run — bounded because each one is its own HTTP request. */
const POLL_BATCH = 50;

export type StatusPollSummary = Readonly<{
  checked: number;
  updated: number;
  /**
   * Rows the window has closed on while they were still open — messages the
   * provider took payment for and never reported an outcome on. Counted rather
   * than inferred from silence, because silence is exactly what this used to be.
   */
  unconfirmed: number;
}>;

const EMPTY: StatusPollSummary = { checked: 0, updated: 0, unconfirmed: 0 };

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

  const cutoff = new Date(now.getTime() - POLL_WINDOW_HOURS * 3_600_000);
  /*
   * What makes a row one of ours to ask about, apart from how old it is.
   *
   * Written once because it is now needed twice — for the rows still inside the
   * window, and for the ones that have left it without an answer. Two copies of
   * this that drifted apart would report a number about a different set of rows
   * than the one being polled, which is worse than not reporting it.
   *
   * The provider-message-id filter is the load-bearing one. A row sent while
   * the provider was `log` carries a fake id in that provider's own namespace,
   * and asking sms.md about one is a 404 against somebody's account — repeated
   * every run, because a 404 leaves the row open and it is selected again. That
   * is what happened on the pilot the day the provider was switched: the queue
   * still held rows from before the switch, and their ids were polled for as
   * long as the window kept them.
   */
  const stillOpen = and(
    eq(notificationOutbox.channel, "sms"),
    eq(notificationOutbox.status, "sent"),
    isNotNull(notificationOutbox.providerMessageId),
    notLike(notificationOutbox.providerMessageId, `${LOGGED_MESSAGE_ID_PREFIX}%`),
    or(
      isNull(notificationOutbox.providerStatus),
      inArray(notificationOutbox.providerStatus, [...OPEN_STATUSES]),
    ),
  );

  const open = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ id: notificationOutbox.id, providerMessageId: notificationOutbox.providerMessageId })
      .from(notificationOutbox)
      .where(and(stillOpen, gte(notificationOutbox.sentAt, cutoff)))
      .orderBy(asc(notificationOutbox.sentAt))
      .limit(input.limit ?? POLL_BATCH),
  );

  /*
   * The other side of the window, and the reason this function grew a third
   * number. Polling stops at a day, which is right — a carrier that has not
   * resolved a message by then is not going to. What was wrong is that it
   * stopped without saying anything: the row kept `accepted`, the delivery rate
   * counted it in neither half of its fraction, and a message the provider
   * charged for and never sent looked exactly like one it delivered.
   */
  const [aged] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ value: count() })
      .from(notificationOutbox)
      .where(and(stillOpen, lt(notificationOutbox.sentAt, cutoff))),
  );
  const unconfirmed = aged?.value ?? 0;

  let checked = 0;
  let updated = 0;
  let unknownIds = 0;
  const unmappedStatuses = new Set<number>();

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
    if (!providerStatus) {
      /*
       * A status this build has no meaning for. `UNRESOLVED_STATUS_ID` is the
       * one that belongs here — the platform saying it never found out — and
       * anything else is their list having grown since this map was written.
       * That is how 4 and 5 hid for as long as they did: skipped in silence,
       * every run, with the row left as it was.
       */
      if (typeof statusId === "number" && statusId !== UNRESOLVED_STATUS_ID) {
        unmappedStatuses.add(statusId);
      }
      continue;
    }

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
      { checked, updated, unknown_ids: unknownIds, unconfirmed },
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

  /*
   * Said out loud every run it is true, like the line above it. A message the
   * provider was paid for and never reported on is not a transient condition
   * that clears itself: it stays wrong until somebody asks the provider about
   * it, and the run that stops mentioning it is the run it goes back to being
   * invisible.
   */
  if (unconfirmed > 0) {
    logEvent(
      "warn",
      "notification.delivery_unconfirmed",
      { organizationId: input.organizationId },
      { unconfirmed, window_hours: POLL_WINDOW_HOURS },
    );
  }

  // Their status list has grown past this map. Nothing is broken yet — the rows
  // keep the last status they had — but every one of these is a delivery
  // outcome being thrown away, and the map is a one-line fix once it is known.
  if (unmappedStatuses.size > 0) {
    logEvent(
      "warn",
      "notification.status_unmapped",
      { organizationId: input.organizationId },
      { status_ids: [...unmappedStatuses].sort((a, b) => a - b) },
    );
  }

  return { checked, updated, unconfirmed };
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
    providerStatus: PolledStatus;
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
