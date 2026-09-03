import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import { notificationOutbox, notificationProviderEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { MAX_DELIVERY_ATTEMPTS } from "@/domain/notification-schedule";
import {
  cancelPendingNotifications,
  notifyBooking,
  scheduleBookingReminder,
} from "@/lib/booking-notifications";
import { createBooking } from "@/lib/booking-service";
import { dispatchDueNotifications } from "@/lib/notification-dispatch";
import {
  setNotificationProvider,
  type DeliveryResult,
  type OutgoingMessage,
} from "@/lib/notification-provider";
import { handleVerifiedResendWebhook } from "@/lib/resend-webhook";
import { pollSmsMdDeliveryStatuses } from "@/lib/smsmd-delivery-status";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import {
  createClient,
  createLocation,
  createOrganization,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The delivery half of section 7.7, against real PostgreSQL: retries with
 * exponential backoff, dead letters when the attempts run out, idempotency, and
 * the pause switch of the section 7 rollback.
 *
 * The provider is a fake that answers however each scenario needs, which is the
 * only way to test "the provider timed out" without a provider — and the reason
 * delivery sits behind an interface at all.
 */
const SLOT = {
  start: new Date("2026-09-04T07:00:00.000Z"),
  end: new Date("2026-09-04T08:30:00.000Z"),
};

const LINES = [
  {
    kind: "service" as const,
    serviceId: null,
    addOnId: null,
    nameSnapshot: { ru: "Маникюр" },
    priceMinor: 60_000,
    durationMinutes: 90,
  },
];

function fakeProvider(answers: DeliveryResult[] | ((message: OutgoingMessage) => DeliveryResult)) {
  const sent: OutgoingMessage[] = [];
  const queue = Array.isArray(answers) ? [...answers] : null;

  setNotificationProvider({
    name: "fake",
    async send(message) {
      sent.push(message);
      if (queue) {
        return queue.shift() ?? { ok: true, providerMessageId: `fake:${sent.length}` };
      }
      return (answers as (message: OutgoingMessage) => DeliveryResult)(message);
    },
  });

  return sent;
}

describe("notification outbox", () => {
  let organizationId: string;
  let locationId: string;
  let bookingId: string;
  /**
   * The fixture's clock, for the rows whose time this file decides: an
   * appointment three days out, a reminder due the day before it.
   *
   * It is not the clock to dispatch on. A message enters the queue at the
   * database's own `now()`, so a dispatch pinned to a date already past claims
   * nothing at all — the four tests below dispatch on the real clock for that
   * reason, and the ones that reach forward to a scheduled reminder do not have
   * to.
   */
  const now = new Date("2026-09-01T09:00:00.000Z");

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    const organization = await createOrganization({ ownerId: user.id, name: "Green Nails" });
    organizationId = organization.id;
    const location = await createLocation(organizationId);
    locationId = location.id;
    const specialist = await createSpecialist(organizationId);
    const client = await createClient(organizationId, {
      normalizedPhone: "+37369123456",
      email: "client@example.com",
    });

    bookingId = await withTenant(organizationId, async (tx) => {
      const created = await createBooking(tx, {
        organizationId,
        locationId,
        specialistId: specialist.id,
        clientId: client.id,
        interval: SLOT,
        source: "public_booking",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now,
      });
      if (!created.ok) throw new Error("fixture booking was refused");
      return created.bookingId;
    });
  });

  afterEach(() => {
    setNotificationProvider(null);
    delete process.env.NOTIFICATIONS_ENABLED;
    delete process.env.NOTIFICATION_PROVIDER;
    delete process.env.SMS_PROVIDER;
    delete process.env.SMSMD_API_TOKEN;
    delete process.env.SMSMD_SENDER_ID;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  async function rows() {
    return adminDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, organizationId));
  }

  test("one event reaches every channel the client has", async () => {
    const sent = fakeProvider([]);
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    const summary = await dispatchDueNotifications({ organizationId, now: new Date() });
    expect(summary).toMatchObject({ claimed: 2, sent: 2, retried: 0, deadLettered: 0 });
    expect(sent.map((message) => message.channel).sort()).toEqual(["email", "sms"]);
    expect(sent.every((message) => message.body.includes("Green Nails"))).toBe(true);
  });

  test("Resend for email does not stop SMS from also being queued", async () => {
    // The two channels are chosen independently (see `notifyBooking`): which
    // adapter answers for email must not decide whether SMS is attempted at
    // all — it used to, back when there was no SMS adapter and queuing one
    // meant dead-lettering it forever.
    process.env.NOTIFICATION_PROVIDER = "resend";
    const sent = fakeProvider([]);
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    const summary = await dispatchDueNotifications({ organizationId, now: new Date() });
    expect(summary).toMatchObject({ claimed: 2, sent: 2, deadLettered: 0 });
    expect(sent.map((message) => message.channel).sort()).toEqual(["email", "sms"]);
  });

  test("a sent message is not sent again", async () => {
    const sent = fakeProvider([]);
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );
    await dispatchDueNotifications({ organizationId, now: new Date() });

    // Same logical send, same key: the second write is a no-op, and a second
    // dispatch finds nothing due.
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );
    const second = await dispatchDueNotifications({ organizationId, now: new Date() });

    expect(second.claimed).toBe(0);
    expect(sent).toHaveLength(2);
    expect(await rows()).toHaveLength(2);
  });

  test("signed provider events are deduplicated and cannot rewind delivery state", async () => {
    process.env.NOTIFICATION_PROVIDER = "resend";
    setNotificationProvider({
      name: "resend-test",
      async send(message) {
        return { ok: true, providerMessageId: `resend-${message.channel}` };
      },
    });
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );
    await dispatchDueNotifications({ organizationId, now: new Date() });

    const [email] = (await rows()).filter((row) => row.channel === "email");
    const event = (type: string, createdAt: string) => ({
      type,
      created_at: createdAt,
      data: {
        email_id: "resend-email",
        tags: { organization_id: organizationId, notification_id: email.id },
      },
    });

    await expect(
      handleVerifiedResendWebhook(event("email.delivered", "2026-09-01T09:02:00.000Z"), "evt-delivered"),
    ).resolves.toBe("recorded");
    await expect(
      handleVerifiedResendWebhook(event("email.delivered", "2026-09-01T09:02:00.000Z"), "evt-delivered"),
    ).resolves.toBe("duplicate");
    // A late-arriving historical bounce is retained for diagnosis but must not
    // replace the chronologically newer delivered summary.
    await expect(
      handleVerifiedResendWebhook(event("email.bounced", "2026-09-01T09:01:00.000Z"), "evt-bounced-old"),
    ).resolves.toBe("recorded");

    const [after] = await rows();
    expect(after.providerStatus).toBe("delivered");
    expect(after.providerEventAt?.toISOString()).toBe("2026-09-01T09:02:00.000Z");
    expect(await adminDb.select().from(notificationProviderEvents)).toHaveLength(2);
  });

  test("provider events without trusted routing tags or message match are acknowledged but ignored", async () => {
    const common = {
      type: "email.delivered",
      created_at: "2026-09-01T09:02:00.000Z",
      data: { email_id: "unknown", tags: {} },
    };
    await expect(handleVerifiedResendWebhook(common, "evt-no-tags")).resolves.toBe("unmatched");
    expect(await adminDb.select().from(notificationProviderEvents)).toHaveLength(0);
  });

  test("a temporary failure comes back later, with a growing gap", async () => {
    fakeProvider(() => ({ ok: false, code: "provider_timeout", retryable: true }));
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    const at = new Date();
    const summary = await dispatchDueNotifications({ organizationId, now: at });
    expect(summary).toMatchObject({ retried: 2, sent: 0, deadLettered: 0 });

    const [row] = await rows();
    expect(row.status).toBe("retry");
    expect(row.attempts).toBe(1);
    expect(row.lastErrorCode).toBe("provider_timeout");
    expect(row.nextAttemptAt.toISOString()).toBe(new Date(at.getTime() + 60_000).toISOString());

    // Nothing is due until the delay has passed.
    expect(await dispatchDueNotifications({ organizationId, now: at })).toMatchObject({
      claimed: 0,
    });
  });

  test("attempts run out and the message becomes a dead letter", async () => {
    fakeProvider(() => ({ ok: false, code: "provider_timeout", retryable: true }));
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    let at = new Date();
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await dispatchDueNotifications({ organizationId, now: at });
      at = new Date(at.getTime() + 2 * 60 * 60_000);
    }

    const all = await rows();
    expect(all.every((row) => row.status === "dead_letter")).toBe(true);
    expect(all.every((row) => row.attempts === MAX_DELIVERY_ATTEMPTS)).toBe(true);
  });

  test("a message this build has no wording for is dead-lettered, not garbled", async () => {
    const sent = fakeProvider(() => ({ ok: true, providerMessageId: "fake:1" }));
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );
    // What a row written by a newer deployment looks like to this one.
    await adminDb
      .update(notificationOutbox)
      .set({ template: "booking.invoice_issued" })
      .where(eq(notificationOutbox.organizationId, organizationId));

    const summary = await dispatchDueNotifications({ organizationId, now: new Date() });

    expect(summary).toMatchObject({ sent: 0, retried: 0, deadLettered: 2 });
    // The point of the guard: the client hears nothing rather than hearing
    // "undefined.body", and the row keeps its cause for whoever looks.
    expect(sent).toEqual([]);
    const all = await rows();
    expect(all.every((row) => row.status === "dead_letter")).toBe(true);
    expect(all.every((row) => row.lastErrorCode === "template_unknown")).toBe(true);
  });

  test("a permanent failure is not retried at all", async () => {
    fakeProvider(() => ({ ok: false, code: "invalid_destination", retryable: false }));
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    const summary = await dispatchDueNotifications({ organizationId, now: new Date() });
    expect(summary).toMatchObject({ deadLettered: 2, retried: 0 });
    expect((await rows()).every((row) => row.attempts === 1)).toBe(true);
  });

  test("a provider that throws is treated as one that did not answer", async () => {
    setNotificationProvider({
      name: "broken",
      async send() {
        throw new Error("socket hang up");
      },
    });
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    const summary = await dispatchDueNotifications({ organizationId, now: new Date() });
    expect(summary).toMatchObject({ retried: 2 });
    expect((await rows()).every((row) => row.status === "retry")).toBe(true);
  });

  test("paused delivery keeps the queue instead of emptying it", async () => {
    const sent = fakeProvider([]);
    process.env.NOTIFICATIONS_ENABLED = "false";
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.cancelled" }),
    );

    expect(await dispatchDueNotifications({ organizationId, now: new Date() })).toMatchObject({
      claimed: 0,
    });
    expect(sent).toHaveLength(0);
    expect((await rows()).every((row) => row.status === "pending")).toBe(true);

    // Section 7's rollback: unpausing sends what accumulated.
    process.env.NOTIFICATIONS_ENABLED = "true";
    expect(await dispatchDueNotifications({ organizationId, now: new Date() })).toMatchObject({
      sent: 2,
    });
  });

  test("a reminder waits for its moment and then goes", async () => {
    const sent = fakeProvider([]);
    const at = await withTenant(organizationId, (tx) =>
      scheduleBookingReminder(tx, { organizationId, bookingId, locationId, startsAt: SLOT.start, now }),
    );

    // Twenty-four hours before the appointment, by default.
    expect(at?.toISOString()).toBe("2026-09-03T07:00:00.000Z");
    expect(await dispatchDueNotifications({ organizationId, now })).toMatchObject({ claimed: 0 });

    const summary = await dispatchDueNotifications({
      organizationId,
      now: new Date("2026-09-03T07:00:01.000Z"),
    });
    expect(summary).toMatchObject({ sent: 2 });
    expect(sent[0].body).toContain("/booking/");
  });

  test("a cancelled appointment takes its pending reminder with it", async () => {
    await withTenant(organizationId, (tx) =>
      scheduleBookingReminder(tx, { organizationId, bookingId, locationId, startsAt: SLOT.start, now }),
    );
    const dropped = await withTenant(organizationId, (tx) =>
      cancelPendingNotifications(tx, bookingId),
    );

    expect(dropped).toBe(2);
    expect(await rows()).toHaveLength(0);
  });

  test("a reminder for a booking that is no longer active is never sent", async () => {
    const sent = fakeProvider([]);
    await withTenant(organizationId, (tx) =>
      scheduleBookingReminder(tx, { organizationId, bookingId, locationId, startsAt: SLOT.start, now }),
    );
    // The safety net, not the normal path: cancelling drops the reminder, so
    // this is the row left behind by anything that did not.
    await adminDb
      .update((await import("@/db/schema")).bookings)
      .set({ status: "cancelled", cancelledAt: now, cancelledBy: "client" })
      .where(eq((await import("@/db/schema")).bookings.id, bookingId));

    const summary = await dispatchDueNotifications({
      organizationId,
      now: new Date("2026-09-03T08:00:00.000Z"),
    });
    expect(summary).toMatchObject({ deadLettered: 2, sent: 0 });
    expect(sent).toHaveLength(0);
    expect((await rows()).every((row) => row.lastErrorCode === "booking_inactive")).toBe(true);
  });

  test("a client with no way to be reached queues nothing", async () => {
    const silent = await createClient(organizationId, { normalizedPhone: null, email: null });
    const { bookings } = await import("@/db/schema");
    await adminDb.update(bookings).set({ clientId: silent.id }).where(eq(bookings.id, bookingId));

    const channels = await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    expect(channels).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });

  /**
   * sms.md's own delivery callback carries nothing that says which tenant a
   * message belongs to, so statuses are read back instead of awaited. What
   * that has to get right is everything a webhook would: one event per status,
   * no rewinding, and a message that has finished being asked about again.
   */
  test("sms.md delivery statuses are polled until they reach a terminal one", async () => {
    process.env.SMS_PROVIDER = "smsmd";
    process.env.SMSMD_API_TOKEN = "smsmd_test_token";
    process.env.SMSMD_SENDER_ID = "NailProfit";

    setNotificationProvider({
      name: "smsmd-test",
      async send() {
        return { ok: true, providerMessageId: "smsmd-msg-1" };
      },
    });
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );
    await dispatchDueNotifications({ organizationId, now: new Date() });

    const [sms] = (await rows()).filter((row) => row.channel === "sms");
    const requested: string[] = [];
    const answer = (statusId: number, name: string, dateUpdated: string) =>
      (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return new Response(
          JSON.stringify({
            status: "success",
            httpCode: 200,
            data: { id: "smsmd-msg-1", status: { id: statusId, name }, dateUpdated },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

    await expect(
      pollSmsMdDeliveryStatuses({
        organizationId,
        fetchImpl: answer(2, "Sent", "2026-09-01T12:02:00+03:00"),
      }),
    ).resolves.toEqual({ checked: 1, updated: 1 });
    expect(requested).toEqual(["https://api.sms.md/v3/messages/smsmd-msg-1"]);

    // The same status again is the normal case for polling, not an anomaly:
    // the row stays open until it is terminal, so every run re-reads it.
    await expect(
      pollSmsMdDeliveryStatuses({
        organizationId,
        fetchImpl: answer(2, "Sent", "2026-09-01T12:02:00+03:00"),
      }),
    ).resolves.toEqual({ checked: 1, updated: 0 });

    await expect(
      pollSmsMdDeliveryStatuses({
        organizationId,
        fetchImpl: answer(3, "Delivered", "2026-09-01T12:03:00+03:00"),
      }),
    ).resolves.toEqual({ checked: 1, updated: 1 });

    const [delivered] = (await rows()).filter((row) => row.channel === "sms");
    expect(delivered.providerStatus).toBe("delivered");
    // Their own timestamp, not ours: the status changed when the carrier said so.
    expect(delivered.providerEventAt?.toISOString()).toBe("2026-09-01T09:03:00.000Z");
    expect(
      (await adminDb.select().from(notificationProviderEvents)).filter(
        (event) => event.notificationId === sms.id,
      ),
    ).toHaveLength(2);

    // Delivered is the end of it — nothing is asked about a second time.
    await expect(
      pollSmsMdDeliveryStatuses({
        organizationId,
        fetchImpl: answer(3, "Delivered", "2026-09-01T12:04:00+03:00"),
      }),
    ).resolves.toEqual({ checked: 0, updated: 0 });
  });

  test("an sms.md status the platform itself could not resolve is left unrecorded", async () => {
    process.env.SMS_PROVIDER = "smsmd";
    process.env.SMSMD_API_TOKEN = "smsmd_test_token";
    process.env.SMSMD_SENDER_ID = "NailProfit";

    setNotificationProvider({
      name: "smsmd-test",
      async send() {
        return { ok: true, providerMessageId: "smsmd-msg-2" };
      },
    });
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );
    await dispatchDueNotifications({ organizationId, now: new Date() });

    // 8 "Unknown" means the platform never learned what happened. Writing
    // `failed` would report a failure nobody observed.
    const summary = await pollSmsMdDeliveryStatuses({
      organizationId,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            status: "success",
            httpCode: 200,
            data: { id: "smsmd-msg-2", status: { id: 8, name: "Unknown" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    expect(summary).toEqual({ checked: 1, updated: 0 });
    const [sms] = (await rows()).filter((row) => row.channel === "sms");
    // Exactly as the send left it: `accepted` is this deployment's own record
    // that the platform took the message, and nothing since has contradicted it.
    expect(sms.providerStatus).toBe("accepted");
    expect(sms.providerEventAt).toBeNull();
    expect(await adminDb.select().from(notificationProviderEvents)).toHaveLength(0);
  });
});
