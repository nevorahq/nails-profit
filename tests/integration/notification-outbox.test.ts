import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import { notificationOutbox } from "@/db/schema";
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

  test("a temporary failure comes back later, with a growing gap", async () => {
    fakeProvider(() => ({ ok: false, code: "provider_timeout", retryable: true }));
    await withTenant(organizationId, (tx) =>
      notifyBooking(tx, { organizationId, bookingId, template: "booking.confirmed" }),
    );

    const at = new Date("2026-09-01T10:00:00.000Z");
    const summary = await dispatchDueNotifications({ organizationId, now: at });
    expect(summary).toMatchObject({ retried: 2, sent: 0, deadLettered: 0 });

    const [row] = await rows();
    expect(row.status).toBe("retry");
    expect(row.attempts).toBe(1);
    expect(row.lastErrorCode).toBe("provider_timeout");
    expect(row.nextAttemptAt.toISOString()).toBe("2026-09-01T10:01:00.000Z");

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

    let at = new Date("2026-09-01T10:00:00.000Z");
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await dispatchDueNotifications({ organizationId, now: at });
      at = new Date(at.getTime() + 2 * 60 * 60_000);
    }

    const all = await rows();
    expect(all.every((row) => row.status === "dead_letter")).toBe(true);
    expect(all.every((row) => row.attempts === MAX_DELIVERY_ATTEMPTS)).toBe(true);
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
});
