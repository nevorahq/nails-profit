import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { bookings, clients, notificationOutbox, organizations } from "@/db/schema";
import { dispatchDueNotifications } from "@/lib/notification-dispatch";
import { formatAppointmentTime } from "@/lib/notification-message";
import {
  setNotificationProvider,
  type OutgoingMessage,
} from "@/lib/notification-provider";
import { anonymous, dataOf, type Actor } from "../helpers/api";
import { wednesdayAhead } from "../helpers/calendar";
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

/**
 * `week` exists because the studio works one weekday and a visit is ninety
 * minutes: six slots to a Wednesday, and this file books more appointments than
 * that. Tests that care which card takes the booking ask for a week of their
 * own rather than competing for the same six hours.
 */
async function requestAppointment(
  specialistId: string = "any",
  week = 1,
  contact: { name?: string; phone?: string; email?: string | null } = {},
) {
  const slots = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
    await anonymous.get(
      `/api/v1/public/booking/notify-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=${specialistId}&date=${wednesdayAhead(week)}`,
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

  const created = dataOf<{ id: string; status: string; manage_token: string }>(
    await anonymous.post(
      "/api/v1/public/booking/notify-studio/bookings",
      {
        hold_token: held.hold_token,
        service_id: studio.serviceId,
        add_on_ids: [],
        name: contact.name ?? "Анна",
        phone: contact.phone ?? "+373 69 123 456",
        // The pilot's provider is email, so the public form requires one; the
        // client's own message is the second one this dispatch sends.
        // `??` cannot say "no address": a client who left only a number is the
        // case half of these tests are about.
        email: "email" in contact ? contact.email : "client@studio.example",
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

    type Bell = { pending: { id: string }[] };
    const mineBell = dataOf<Bell>(await mine.get("/api/v1/notifications"));
    const theirBell = dataOf<Bell>(await theirs.get("/api/v1/notifications"));
    expect(mineBell.pending.map((row) => row.id)).toContain(booking.id);
    // Not "does not contain this one": a master with no requests of their own
    // has an empty list, however busy the studio around them is.
    expect(theirBell.pending).toEqual([]);
  });
});

describe("a request the studio answers", () => {
  /**
   * The other end of the message above. The studio was told somebody was
   * waiting; when a person takes the request, the client is told who took it
   * and when they are expected.
   *
   * By email, though the client also left a phone. This message answers
   * something the client did and were waiting on, so it finds them already
   * looking — and SMS is kept for the reminder alone, which is the one message
   * that has to reach a day that moved on. The manage link rides along, because
   * being told yes does not end the client's business with the appointment.
   */
  test("tells the client who accepted it and when", async () => {
    const card = await bookableCard("Ирина");
    const booking = await requestAppointment(card);
    expect(booking.status).toBe("pending_confirmation");

    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);
    capturingProvider();

    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const accepted = sent.filter((message) => message.body.includes("принята мастером Ирина"));
    expect([...accepted].map((message) => message.channel).sort()).toEqual(["email"]);
    expect([...new Set(accepted.map((message) => message.destination))].sort()).toEqual([
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

    /*
     * By email, and only by email. The client left a phone as well, and this
     * message used to go there too — but SMS now carries the confirmation and
     * the reminder and nothing else, and a thank-you after the visit is the
     * clearest case of a message worth writing and not worth interrupting
     * somebody's evening for.
     */
    const thanks = sent.filter((message) => message.body.includes("/book/notify-studio"));
    expect([...new Set(thanks.map((message) => message.destination))].sort()).toEqual([
      "client@studio.example",
    ]);
    // Not a manage link: the appointment is over, and there is nothing left on
    // it to move or cancel.
    for (const message of thanks) expect(message.body).not.toContain("/booking/");
  });
});


/**
 * The three things a client can do on the public page that the studio used to
 * find out about only by opening the calendar.
 *
 * By this point in the file `studio.specialistId` carries an account, so each
 * of these is expected to reach two people: the master whose chair it is, and
 * the owner, who sees everything.
 */
describe("what a client does on the public page", () => {
  /** The studio's other setting: a public booking that needs no answer. */
  async function withInstantConfirmation<T>(run: () => Promise<T>): Promise<T> {
    const settings = (mode: "instant" | "manual") =>
      studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
        public_status: "published",
        confirmation_mode: mode,
        min_lead_minutes: 0,
        max_advance_days: 90,
      });

    await settings("instant");
    try {
      return await run();
    } finally {
      await settings("manual");
    }
  }

  /** Everyone in the studio this booking's messages were addressed to. */
  function studioReadersOf(bookingId: string, subjectContains?: string) {
    const aboutIt = sent.filter((message) => message.body.includes(`/app/calendar/${bookingId}`));
    const matching = subjectContains
      ? aboutIt.filter((message) => message.subject.includes(subjectContains))
      : aboutIt;
    // Email and nothing else: the studio side of the product has an account
    // with an address, never a phone number.
    for (const message of matching) expect(message.channel).toBe("email");
    return [...new Set(matching.map((message) => message.destination))].sort();
  }

  test("an instant booking asks for no answer and still reaches the studio", async () => {
    const booking = await withInstantConfirmation(() =>
      requestAppointment(studio.specialistId, 3),
    );
    expect(booking.status).toBe("confirmed");

    const queued = await adminDb
      .select({ template: notificationOutbox.template, channel: notificationOutbox.channel })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, booking.id));
    expect(queued).toContainEqual({ template: "booking.staff_booked", channel: "email" });
    // Nothing is waiting on anybody, so nothing says it is.
    expect(queued.map((row) => row.template)).not.toContain("booking.staff_requested");

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    expect(studioReadersOf(booking.id)).toEqual([
      "notify-master@studio.example",
      "staff-notify-owner@studio.example",
    ]);
  });

  test("moving the time tells the studio which time it moved to", async () => {
    const booking = await requestAppointment(studio.specialistId, 4);
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    const current = dataOf<{ version: number }>(
      await anonymous.get(`/api/v1/public/bookings/${booking.manage_token}`),
    );
    const available = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/notify-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=${studio.specialistId}&date=${wednesdayAhead(8)}`,
      ),
    );
    const destination = available.slots[0];
    expect(destination).toBeDefined();

    const moved = dataOf<{ starts_at: string }>(
      await anonymous.post(
        `/api/v1/public/bookings/${booking.manage_token}/reschedule`,
        {
          starts_at: destination.starts_at,
          specialist_id: destination.specialist_id,
          version: current.version,
        },
        { "idempotency-key": `staff-move-${crypto.randomUUID()}` },
      ),
    );

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    expect(studioReadersOf(booking.id, "перенёс")).toEqual([
      "notify-master@studio.example",
      "staff-notify-owner@studio.example",
    ]);

    const moves = sent.filter((message) => message.subject.includes("перенёс"));
    for (const message of moves) {
      // The new hour, in the location's zone: a message naming the old one
      // would send the master to an empty chair.
      expect(message.body).toContain(
        formatAppointmentTime(new Date(moved.starts_at), "Europe/Chisinau", "ru"),
      );
      // And whose chair it is, which is the whole of what the owner's copy is
      // worth: they are reading about a day that is not theirs.
      expect(message.body).toContain("Мастер");
    }
  });

  test("calling it off tells the studio the hour is free again", async () => {
    const booking = await requestAppointment(studio.specialistId, 5);
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    const current = dataOf<{ version: number }>(
      await anonymous.get(`/api/v1/public/bookings/${booking.manage_token}`),
    );
    const cancelled = dataOf<{ status: string }>(
      await anonymous.post(`/api/v1/public/bookings/${booking.manage_token}/cancel`, {
        version: current.version,
      }),
    );
    expect(cancelled.status).toBe("cancelled");

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    expect(studioReadersOf(booking.id, "отменил")).toEqual([
      "notify-master@studio.example",
      "staff-notify-owner@studio.example",
    ]);
  });

  /**
   * The one move that leaves somebody worse off and told nothing.
   *
   * `booking.staff_rescheduled` follows the booking, so when a client lands on
   * another master's day it reaches the master who gained the hour and says
   * nothing to the master who lost it — who is the one with an hour to sell and
   * the one who would otherwise keep it blocked out for a client not coming.
   */
  test("moving to another master tells the one whose hour just came free", async () => {
    const leaving = await inviteMember(studio.owner, "notify-leaving@studio.example", "master");
    const arriving = await inviteMember(studio.owner, "notify-arriving@studio.example", "master");
    const leavingCard = await bookableCard("Уходящая", leaving.userId);
    const arrivingCard = await bookableCard("Принимающая", arriving.userId);

    const booking = await requestAppointment(leavingCard, 9);
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    const current = dataOf<{ version: number }>(
      await anonymous.get(`/api/v1/public/bookings/${booking.manage_token}`),
    );
    const available = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/notify-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=${arrivingCard}&date=${wednesdayAhead(10)}`,
      ),
    );
    const destination = available.slots[0];
    expect(destination).toBeDefined();

    await anonymous.post(
      `/api/v1/public/bookings/${booking.manage_token}/reschedule`,
      {
        starts_at: destination.starts_at,
        specialist_id: destination.specialist_id,
        version: current.version,
      },
      { "idempotency-key": `staff-handover-${crypto.randomUUID()}` },
    );

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const released = sent.filter((message) => message.subject.includes("ушёл с вашего времени"));
    // One reader, and not the owner: they hear about the same move through the
    // message below, and one event is worth one message to a person.
    expect(released.map((message) => message.destination)).toEqual([
      "notify-leaving@studio.example",
    ]);
    for (const message of released) {
      expect(message.channel).toBe("email");
      // The hour that came free — the one the booking has left, which is why
      // this is the message that cannot read its facts off the booking.
      expect(message.body).toContain(
        formatAppointmentTime(new Date(booking.startsAt), "Europe/Chisinau", "ru"),
      );
      // And where the client went, so nobody has to open the calendar to see
      // that they are still coming to the studio.
      expect(message.body).toContain("Принимающая");
    }

    // The move itself still reaches the day it landed on, and the owner.
    expect(studioReadersOf(booking.id, "перенёс")).toEqual([
      "notify-arriving@studio.example",
      "staff-notify-owner@studio.example",
    ]);
  });

  /**
   * The other half of `staffMessageStillHolds`. The queue is drained on a timer,
   * so a request can be answered in the calendar before its message leaves —
   * and "запрос ждёт подтверждения" would then send somebody to confirm
   * something already confirmed.
   */
  test("says nothing about a request that was answered before the queue drained", async () => {
    const booking = await requestAppointment(studio.specialistId, 6);
    expect(booking.status).toBe("pending_confirmation");
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    expect(studioReadersOf(booking.id)).toEqual([]);

    // Not lost quietly: the row carries why it was dropped, so an operator
    // reading the queue can tell this apart from a provider that refused it.
    const rows = await adminDb
      .select({ status: notificationOutbox.status, code: notificationOutbox.lastErrorCode })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, booking.id));
    expect(rows).toContainEqual({ status: "dead_letter", code: "booking_moved_on" });
  });
});

/**
 * One number, two people.
 *
 * A public request is matched to an existing card by number or address, and the
 * card is deliberately left as the studio wrote it — otherwise whoever holds
 * the link gets to rename the studio's client, and every appointment in the
 * calendar is labelled from that row. What used to happen to the name typed on
 * the form was nothing at all: it was read once, to decide whether a card had
 * to be made, and then dropped. So a mother's number used by her daughter
 * produced a request the master read as the mother's, with nothing anywhere
 * saying otherwise — the studio's own report, and the reason this file now
 * asserts on both names rather than one.
 */
describe("a request made under a name the card does not carry", () => {
  const household = { phone: "+373 69 123 457", email: "household@studio.example" };

  test("reaches the studio as the person coming, with the card named under it", async () => {
    const hers = await requestAppointment("any", 7, { ...household, name: "Люда" });
    const daughters = await requestAppointment("any", 8, { ...household, name: "Ольга" });

    type Waiting = { id: string; client_name: string | null; client_card_name: string | null };
    const waiting = dataOf<{ pending: Waiting[] }>(
      await studio.owner.get("/api/v1/notifications"),
    ).pending;

    // The second request: booked by Ольга, filed against Люда's card.
    const second = waiting.find((item) => item.id === daughters.id);
    expect(second?.client_name).toBe("Ольга");
    expect(second?.client_card_name).toBe("Люда");

    // The first, which made the card, says one name because there is one.
    const first = waiting.find((item) => item.id === hers.id);
    expect(first?.client_name).toBe("Люда");
    expect(first?.client_card_name).toBeNull();

    // And the card itself is untouched by the second request, as before.
    const [card] = await adminDb
      .select({ name: clients.name })
      .from(clients)
      .where(
        and(
          eq(clients.organizationId, studio.organizationId),
          eq(clients.email, household.email),
        ),
      );
    expect(card.name).toBe("Люда");

    // Stored only where it says something: the first booking carries no second
    // name, because there is no second name to carry.
    const rows = await adminDb
      .select({ id: bookings.id, bookedAs: bookings.clientNameSnapshot })
      .from(bookings)
      .where(inArray(bookings.id, [hers.id, daughters.id]));
    expect(rows.find((row) => row.id === hers.id)?.bookedAs).toBeNull();
    expect(rows.find((row) => row.id === daughters.id)?.bookedAs).toBe("Ольга");
  });
});

/**
 * The other half of the same request: what the client hears when it is
 * answered.
 *
 * It lives in this file because this is where a request that a studio has to
 * answer exists — a booking taken at the desk is confirmed on the spot and was
 * never a request at all.
 *
 * A public booking does not ask for an email. A client who gave only a number
 * was therefore queued nothing when their request was accepted: not an SMS,
 * because the rule then carried only a cancellation and a move, and no address
 * for the email that would have carried it. The studio answered, and the answer
 * reached nobody.
 */
describe("a client who booked without an address", () => {
  async function clientRowsFor(bookingId: string) {
    const rows = await adminDb
      .select({ template: notificationOutbox.template, channel: notificationOutbox.channel })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, bookingId));
    return rows.filter((row) => row.template === "booking.request_accepted");
  }

  test("is texted that the studio accepted their request", async () => {
    const booking = await requestAppointment("any", 10, {
      name: "Ольга",
      phone: "+373 69 555 444",
      email: null,
    });
    expect(booking.status).toBe("pending_confirmation");

    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    expect(await clientRowsFor(booking.id)).toEqual([
      { template: "booking.request_accepted", channel: "sms" },
    ]);
  });

  /**
   * And the client who did leave one hears it exactly as before. The SMS is a
   * replacement for an inbox, not a second copy for everyone: a studio pays per
   * message, and this one would be paid for twice.
   */
  test("a client with an address still hears it by email alone", async () => {
    const booking = await requestAppointment("any", 11, {
      name: "Раиса",
      phone: "+373 69 555 555",
      email: "raisa@studio.example",
    });

    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    expect(await clientRowsFor(booking.id)).toEqual([
      { template: "booking.request_accepted", channel: "email" },
    ]);
  });
});

/**
 * The bell's other half: what already happened, for people who were not
 * looking at the screen when it did.
 *
 * A studio's report, 13.09.2026: a client called off a visit and the master's
 * page said nothing. Nothing was broken — the bell listed unanswered requests
 * and only those, so a cancellation had no place in it to appear, and the email
 * a minute later was the whole of the studio's warning.
 */
describe("the studio's own feed", () => {
  type Feed = {
    unread: number;
    feed: {
      booking_id: string;
      kind: string;
      unread: boolean;
      earlier: string[];
      previous_local_date: string | null;
    }[];
  };

  const bellOf = async (actor: Actor) =>
    dataOf<Feed>(await actor.get("/api/v1/notifications"));

  test("carries a cancellation the client made, and marks it new", async () => {
    const booking = await requestAppointment("any", 12, {
      name: "Ольга",
      phone: "+373 69 556 001",
    });
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    /*
     * The client, on their own link, with nobody in the studio watching. The
     * token is the one their booking gave them — the studio's own reissue
     * endpoint deliberately never hands it back, which is a rule worth not
     * working around even in a test.
     *
     * The version travels with the cancellation the way it does on the page: it
     * is what stops a stale tab calling off an appointment that has moved.
     */
    const manage = booking.manage_token;
    const current = dataOf<{ version: number }>(
      await anonymous.get(`/api/v1/public/bookings/${manage}`),
    );
    expect(
      (
        await anonymous.post(
          `/api/v1/public/bookings/${manage}/cancel`,
          { version: current.version },
          { "idempotency-key": `feed-cancel-${crypto.randomUUID()}` },
        )
      ).status,
    ).toBe(200);

    const bell = await bellOf(studio.owner);
    const line = bell.feed.find((row) => row.booking_id === booking.id);
    expect(line).toMatchObject({ kind: "client_cancelled", unread: true, earlier: [] });
    expect(bell.unread).toBeGreaterThan(0);

    /*
     * And opening the appointment is what reads its line — that one, not the
     * list. The bell used to mark everything read the moment it was opened,
     * which is the right shape for «есть ли что-то новое» and the wrong one for
     * a queue: it emptied itself at a glance.
     */
    expect(
      (await studio.owner.post("/api/v1/notifications/read", { booking_id: booking.id })).status,
    ).toBe(200);
    const afterReading = await bellOf(studio.owner);
    expect(afterReading.feed.find((row) => row.booking_id === booking.id)?.unread).toBe(false);
    // One line fewer waiting, not all of them.
    expect(afterReading.unread).toBe(bell.unread - 1);

    /*
     * And it sank rather than vanished: everything still waiting is above it,
     * everything already dealt with below. Asserted as the boundary rather than
     * as a position, so a test added beside this one cannot move it.
     */
    const index = afterReading.feed.findIndex((row) => row.booking_id === booking.id);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(afterReading.feed.slice(0, index).every((row) => row.unread)).toBe(true);
    expect(afterReading.feed.slice(index + 1).every((row) => !row.unread)).toBe(true);
  });

  /**
   * The rule that keeps the list worth opening: it reports what other people
   * did, never what you just did yourself. An owner who cancels an appointment
   * does not need the app to tell them about it — but the master whose day it
   * was does.
   */
  test("says nothing to whoever did it, and tells the master whose day it was", async () => {
    const master = await inviteMember(studio.owner, "feed-master@studio.example", "master");
    const card = await bookableCard("Лента", master.userId);
    const booking = await requestAppointment(card, 13, {
      name: "Раиса",
      phone: "+373 69 556 002",
    });

    expect(
      (
        await studio.owner.post(`/api/v1/bookings/${booking.id}/cancel`, {
          reason: "studio_request",
          cancelled_by: "staff",
        })
      ).status,
    ).toBe(200);

    const ownersBell = await bellOf(studio.owner);
    expect(ownersBell.feed.map((row) => row.booking_id)).not.toContain(booking.id);

    const mastersBell = await bellOf(master);
    expect(mastersBell.feed.find((row) => row.booking_id === booking.id)).toMatchObject({
      kind: "staff_cancelled",
      unread: true,
    });
  });
});
