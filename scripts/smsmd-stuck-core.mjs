/**
 * Which of sms.md's messages are stuck, separated from how they are fetched.
 *
 * Written after a night when the platform accepted five messages, charged for
 * them, and never handed one to a carrier. Everything on the domestic route
 * delivered in a second; everything on the international route sat at `Queued`
 * with its `dateUpdated` frozen at the moment it was created. The account page
 * shows all of it mixed together, so the shape only became visible once
 * somebody listed the messages and sorted them by carrier by hand. This is that
 * sorting, so nobody has to do it by hand again.
 *
 * Pure on purpose, like the other operator cores here: the judgement — what
 * counts as stuck, and from when — is the part worth being sure about, and it
 * needs neither a network nor a token to test.
 */

/**
 * Statuses that settle a message. 3 delivered it, 9 and 10 failed it, and 8 is
 * the platform saying it never found out — an answer we cannot improve on by
 * asking again, so it ends the wait like the others.
 *
 * Everything else — 1 Queued, 2 Sent, 4 «Повторная отправка», 5 «У оператора» —
 * means somebody is still holding the message. Four and five are absent from
 * `GET /v3/messages/statuses`, which their specification says hides them; they
 * occur in production all the same.
 */
const TERMINAL_STATUS_IDS = new Set([3, 8, 9, 10]);

/**
 * How long a message may sit before sitting is the finding.
 *
 * Fifteen minutes because the healthy case is not minutes, it is one second:
 * every message this account delivered went out within a second of being
 * queued. A threshold near the healthy time would turn every ordinary send into
 * an alarm for a moment; fifteen minutes is far outside normal and still far
 * inside "somebody should look today".
 */
export const DEFAULT_STUCK_MINUTES = 15;

function ageMinutes(message, now) {
  const created = new Date(message.dateCreated);
  if (Number.isNaN(created.getTime())) return null;
  return Math.round((now.getTime() - created.getTime()) / 60_000);
}

/**
 * The stuck messages, newest first, with the numbers that make the case.
 *
 * A message with an unparseable or future timestamp is not stuck — it is
 * unreadable, and reporting it as an incident would spend somebody's attention
 * on a clock problem while describing it as a delivery problem.
 */
export function findStuckMessages(messages = [], { now = new Date(), minutes = DEFAULT_STUCK_MINUTES } = {}) {
  const stuck = [];

  for (const message of messages) {
    const statusId = message?.status?.id;
    if (typeof statusId !== "number" || TERMINAL_STATUS_IDS.has(statusId)) continue;

    const age = ageMinutes(message, now);
    if (age === null || age < minutes) continue;

    stuck.push({
      id: message.id,
      created_at: message.dateCreated,
      age_minutes: age,
      to: message.receiverNumber,
      carrier: message.carrier?.name ?? "unknown",
      sender: message.senderName,
      segments: message.smsCount ?? 0,
      status: message.status?.name ?? String(statusId),
      status_id: statusId,
      /**
       * The tell that separates "slow" from "never handed over": the platform
       * stamps this every time a message's state changes, so one that still
       * equals `dateCreated` hours later has had nothing happen to it at all.
       */
      untouched: message.dateUpdated === message.dateCreated,
    });
  }

  return stuck.sort((left, right) => right.age_minutes - left.age_minutes);
}

/**
 * The same list read as a verdict.
 *
 * Carriers are counted because that is the question the pilot's incident turned
 * on: stuck messages spread across every route is a platform having a bad
 * afternoon, and stuck messages that all share one route is that route being
 * shut. The two need different phone calls.
 */
export function buildStuckReport(messages = [], { now = new Date(), minutes = DEFAULT_STUCK_MINUTES } = {}) {
  const stuck = findStuckMessages(messages, { now, minutes });
  const byCarrier = {};
  for (const message of stuck) {
    byCarrier[message.carrier] = (byCarrier[message.carrier] ?? 0) + 1;
  }

  const carriersSeen = new Set(
    messages.map((message) => message?.carrier?.name).filter((name) => typeof name === "string"),
  );
  const stuckCarriers = Object.keys(byCarrier);

  return {
    generated_at: now.toISOString(),
    verdict: stuck.length === 0 ? "PASS" : "STUCK",
    threshold_minutes: minutes,
    messages_examined: messages.length,
    stuck_messages: stuck.length,
    stuck_segments: stuck.reduce((total, message) => total + message.segments, 0),
    oldest_age_minutes: stuck[0]?.age_minutes ?? null,
    stuck_by_carrier: byCarrier,
    /**
     * True when every stuck message shares one route and some other route is
     * working. That is the shape of a closed direction rather than a slow
     * platform, and it is the sentence to open a support ticket with.
     */
    single_carrier_affected:
      stuckCarriers.length === 1 && carriersSeen.size > 1 ? stuckCarriers[0] : null,
    messages: stuck,
  };
}
