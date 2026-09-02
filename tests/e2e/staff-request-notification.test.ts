import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { bookings, notificationOutbox, organizations } from "@/db/schema";
import { dispatchDueNotifications } from "@/lib/notification-dispatch";
import { formatAppointmentTime } from "@/lib/notification-message";
import {
  setNotificationProvider,
  type OutgoingMessage,
} from "@/lib/notification-provider";
import { anonymous, dataOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Telling the studio that somebody is waiting for an answer.
 *
 * The public flow notified the client — "запрос отправлен" — and nobody else.
 * The appointment then sat in `pending_confirmation` until a person happened to
 * open the calendar, which on the pilot meant a master who never learned there
 * was anything to confirm and a client whose request looked ignored.
 *
 * Two people hear about it: the master the appointment was booked with, and the
 * owner, who sees every request whether or not it is theirs to work. One row
 * each, addressed when the message is sent rather than when it is queued — a
 * card linked to an account in the meantime still routes correctly. A card with
 * no account produces no master's message at all; the owner's copy is then the
 * only one, which is the state this studio was in.
 */
let studio: Studio;
let locationId: string;
let previousFlag: string | undefined;
const sent: OutgoingMessage[] = [];

beforeAll(async () => {
  previousFlag = process.env.PUBLIC_BOOKING_ENABLED;
  process.env.PUBLIC_BOOKING_ENABLED = "true";
  await resetDatabase();
  studio = await createCanonicalStudio("staff-notify-owner@studio.example", "Notify Studio");
  await studio.owner.patch("/api/v1/organizations/settings", { slug: "notify-studio" });
  await adminDb
    .update(organizations)
    .set({ bookingAccess: "public" })
    .where(eq(organizations.id, studio.organizationId));

  locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", {
      name: "Центр",
      slug: "centru",
      address: "str. Ismail 33",
      timezone: "Europe/Chisinau",
    }),
  ).id;
  await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
    location_ids: [locationId],
  });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: studio.specialistId,
    location_id: locationId,
    effective_from: "2026-08-01",
    intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
  });
  // `manual` is what makes a public booking a request rather than an
  // appointment, and a request is the only thing this message is about.
  await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
    public_status: "published",
    confirmation_mode: "manual",
    min_lead_minutes: 0,
    max_advance_days: 90,
  });
}, 60_000);

afterEach(() => {
  setNotificationProvider(null);
  sent.length = 0;
});

afterAll(async () => {
  if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
  else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
  await closeTestConnections();
});

/** A provider that reports success and keeps what it was asked to send. */
function capturingProvider() {
  setNotificationProvider({
    name: "capture",
    async send(message) {
      sent.push(message);
      return { ok: true, providerMessageId: `capture:${sent.length}` };
    },
  });
}

/**
 * The rota is Wednesdays, so a request has to land on one. Computed rather than
 * written down: a fixed date stops being bookable the day after it passes, and
 * this file would then fail for a reason that has nothing to do with what it
 * tests. The next one, never today, so the slots do not depend on the hour the
 * suite happens to run at.
 */
function nextRotaDay(): string {
  const day = new Date();
  day.setUTCHours(12, 0, 0, 0);
  do {
    day.setUTCDate(day.getUTCDate() + 1);
  } while (day.getUTCDay() !== 3);
  return day.toISOString().slice(0, 10);
}

/** A card that can actually be booked, linked to an account when given one. */
async function bookableCard(name: string, userId?: string) {
  const id = dataOf<{ id: string }>(
    // With a commission rule, like the studio's own: a card the "any available"
    // assignment can hand an appointment to is a card whose visit somebody has
    // to be paid for, and closing one without a rule is refused.
    await studio.owner.post("/api/v1/specialists", {
      name,
      cooperation_type: "commission",
      default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
    }),
  ).id;
  if (userId) await studio.owner.patch(`/api/v1/specialists/${id}`, { user_id: userId });
  await studio.owner.put(`/api/v1/specialists/${id}/locations`, { location_ids: [locationId] });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: id,
    location_id: locationId,
    effective_from: "2026-08-01",
    intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
  });
  return id;
}

async function requestAppointment(specialistId: string = "any") {
  const slots = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
    await anonymous.get(
      `/api/v1/public/booking/notify-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=${specialistId}&date=${nextRotaDay()}`,
    ),
  );
  const slot = slots.slots[0];
  expect(slot).toBeDefined();

  const held = dataOf<{ hold_token: string }>(
    await anonymous.post("/api/v1/public/booking/notify-studio/holds", {
      location_id: locationId,
      service_id: studio.serviceId,
      add_on_ids: [],
      specialist_id: slot.specialist_id,
      starts_at: slot.starts_at,
    }),
  );

  const created = dataOf<{ id: string; status: string }>(
    await anonymous.post(
      "/api/v1/public/booking/notify-studio/bookings",
      {
        hold_token: held.hold_token,
        service_id: studio.serviceId,
        add_on_ids: [],
        name: "Анна",
        phone: "+373 69 123 456",
        // The pilot's provider is email, so the public form requires one; the
        // client's own message is the second one this dispatch sends.
        email: "client@studio.example",
        locale: "ru",
        legal_accepted: true,
      },
      { "idempotency-key": `staff-notify-${crypto.randomUUID()}` },
    ),
  );

  return { ...created, startsAt: slot.starts_at };
}

describe("a request nobody in the studio has seen", () => {
  test("queues a message for the studio beside the client's own", async () => {
    const booking = await requestAppointment();
    expect(booking.status).toBe("pending_confirmation");

    const queued = await adminDb
      .select({ template: notificationOutbox.template, channel: notificationOutbox.channel })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, booking.id));

    expect(queued).toContainEqual({ template: "booking.staff_requested", channel: "email" });
  });

  test("reaches the owner alone while the master's card has no account", async () => {
    await requestAppointment();
    capturingProvider();

    await dispatchDueNotifications({ organizationId: studio.organizationId });

    // The studio answers inside the application, so its messages are the ones
    // linking to the appointment rather than to the client's manage page.
    // Deduplicated: a dispatch drains whatever the earlier tests left queued,
    // so what matters is which people were written to, not how many times.
    const toStudio = sent.filter((message) => message.body.includes("/app/calendar/"));
    expect([...new Set(toStudio.map((message) => message.destination))]).toEqual([
      "staff-notify-owner@studio.example",
    ]);
    expect(sent.map((message) => message.destination)).toContain("client@studio.example");
  });

  /**
   * What the scheduled function calls. The queue is drained by an operator
   * endpoint, and until something called it on a timer the whole outbox was a
   * list of messages nobody sent — so the call the cron makes, with no
   * organization named, is worth a test of its own.
   */
  test("is drained by the operator sweep the cron calls, without naming a tenant", async () => {
    const previousToken = process.env.OPS_API_TOKEN;
    process.env.OPS_API_TOKEN = "cron-token-that-is-long-enough-to-pass-32";
    try {
      await requestAppointment();
      capturingProvider();

      const response = await anonymous.post(
        "/api/v1/ops/notifications",
        {},
        { authorization: `Bearer ${process.env.OPS_API_TOKEN}` },
      );

      expect(response.status).toBe(200);
      expect(dataOf<{ sent: number }>(response).sent).toBeGreaterThan(0);
      expect(sent.some((message) => message.body.includes("/app/calendar/"))).toBe(true);
    } finally {
      if (previousToken === undefined) delete process.env.OPS_API_TOKEN;
      else process.env.OPS_API_TOKEN = previousToken;
    }
  });

  test("reaches the master and the owner once the card carries an account", async () => {
    const master = await inviteMember(studio.owner, "notify-master@studio.example", "master");
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, {
      user_id: master.userId,
    });

    await requestAppointment();
    capturingProvider();

    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const toStudio = sent.filter((message) => message.body.includes("/app/calendar/"));
    // The master because it is their chair; the owner because they asked to see
    // every request. Two rows, so neither can swallow the other.
    expect([...new Set(toStudio.map((message) => message.destination))].sort()).toEqual([
      "notify-master@studio.example",
      "staff-notify-owner@studio.example",
    ]);
  });

  /**
   * Section 6.1 gives a Master the `bookings` capability at scope "own", and a
   * request is somebody's own or it is nobody's. The studio the pilot runs has
   * two masters at one address: the message names the chair it was booked into,
   * so the colleague hears nothing — not in their inbox, not in the topbar.
   */
  test("reaches the master it was booked with and not their colleague", async () => {
    const mine = await inviteMember(studio.owner, "notify-mine@studio.example", "master");
    const theirs = await inviteMember(studio.owner, "notify-theirs@studio.example", "master");
    // Both bookable in every way, so what separates them below is the recipient
    // rule and not an accident of who could have taken the appointment.
    const myCard = await bookableCard("Моя", mine.userId);
    await bookableCard("Соседняя", theirs.userId);

    const booking = await requestAppointment(myCard);
    capturingProvider();

    await dispatchDueNotifications({ organizationId: studio.organizationId });

    // This request's own messages, by the link they carry: the queue holds the
    // other tests' bookings too.
    const aboutIt = sent.filter((message) => message.body.includes(`/app/calendar/${booking.id}`));
    expect([...new Set(aboutIt.map((message) => message.destination))].sort()).toEqual([
      "notify-mine@studio.example",
      "staff-notify-owner@studio.example",
    ]);

    const mineBell = dataOf<{ id: string }[]>(await mine.get("/api/v1/notifications"));
    const theirBell = dataOf<{ id: string }[]>(await theirs.get("/api/v1/notifications"));
    expect(mineBell.map((row) => row.id)).toContain(booking.id);
    // Not "does not contain this one": a master with no requests of their own
    // has an empty list, however busy the studio around them is.
    expect(theirBell).toEqual([]);
  });
});

describe("a request the studio answers", () => {
  /**
   * The other end of the message above. The studio was told somebody was
   * waiting; when a person takes the request, the client is told who took it
   * and when they are expected — by every route they left open, because a
   * client who gave a phone and an address reads whichever reaches them first.
   */
  test("tells the client who accepted it and when, by email and by SMS", async () => {
    const card = await bookableCard("Ирина");
    const booking = await requestAppointment(card);
    expect(booking.status).toBe("pending_confirmation");

    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);
    capturingProvider();

    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const accepted = sent.filter((message) => message.body.includes("принята мастером Ирина"));
    expect([...accepted].map((message) => message.channel).sort()).toEqual(["email", "sms"]);
    expect([...new Set(accepted.map((message) => message.destination))].sort()).toEqual([
      "+37369123456",
      "client@studio.example",
    ]);

    for (const message of accepted) {
      // The time as the client reads it: the location's zone, their language.
      expect(message.body).toContain(
        formatAppointmentTime(new Date(booking.startsAt), "Europe/Chisinau", "ru"),
      );
      // Confirming does not end the client's business with the appointment —
      // the way to move or call it off has to survive the good news.
      expect(message.body).toContain("/booking/");
    }
  });
});

describe("after the visit is closed", () => {
  test("thanks the client and points them back at the booking page", async () => {
    const booking = await requestAppointment();
    // A request has to be answered before it can be worked, and closing it into
    // a visit is what this message hangs on.
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);
    // And the appointment has to have happened: a visit cannot be closed
    // before its own time.
    const startsAt = new Date(Date.now() - 2 * 60 * 60_000);
    await adminDb
      .update(bookings)
      .set({ startsAt, endsAt: new Date(startsAt.getTime() + 90 * 60_000) })
      .where(eq(bookings.id, booking.id));
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/complete`, {})).status).toBe(201);

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    // Every way the client left, not whichever row the dispatcher happened to
    // claim first: two messages are queued in one transaction, so they share a
    // due time and the queue orders them by a random id.
    const thanks = sent.filter((message) => message.body.includes("/book/notify-studio"));
    expect([...new Set(thanks.map((message) => message.destination))].sort()).toEqual([
      "+37369123456",
      "client@studio.example",
    ]);
    // Not a manage link: the appointment is over, and there is nothing left on
    // it to move or cancel.
    for (const message of thanks) expect(message.body).not.toContain("/booking/");
  });
});
