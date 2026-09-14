import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { notificationOutbox, staffNotices } from "@/db/schema";
import { dispatchDueNotifications } from "@/lib/notification-dispatch";
import { setNotificationProvider, type OutgoingMessage } from "@/lib/notification-provider";
import { dataOf, type Actor } from "../helpers/api";
import { isoDay, weekdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * What a master learns about their own day when it was the studio that changed
 * it.
 *
 * The sibling file covers the other direction: a client acting on the public
 * page, where nobody in the studio was present and the whole product is built
 * around telling them. The desk was the blind spot. An owner booking a regular
 * in with one of their masters, or handing a master's 14:00 to a colleague,
 * changed somebody's afternoon and told them nothing at all — there was no
 * message for it and, for a booking, not even a kind of line in the feed.
 *
 * The rule both halves now follow: the event changes a working day, so the
 * person whose day it is hears about it — and the person who performed it
 * hears nothing, because a bell that reports your own clicks back to you is a
 * bell people stop opening.
 */
let studio: Studio;
let locationId: string;
let clientId: string;
/** Two cards with accounts, so "who was written to" is a real question. */
let irina: { cardId: string; account: Actor };
let olga: { cardId: string; account: Actor };
const sent: OutgoingMessage[] = [];

const IRINA_EMAIL = "desk-irina@studio.example";
const OLGA_EMAIL = "desk-olga@studio.example";
const OWNER_EMAIL = "desk-owner@studio.example";

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio(OWNER_EMAIL, "Desk Studio");

  locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", {
      name: "Центр",
      slug: "centru",
      address: "str. Ismail 33",
      timezone: "Europe/Chisinau",
    }),
  ).id;

  irina = await bookableMaster("Ирина", IRINA_EMAIL);
  olga = await bookableMaster("Ольга", OLGA_EMAIL);

  /*
   * And a card for the owner, who in a real studio works a chair as well as
   * running the place — `createCanonicalStudio` leaves its card unlinked, and
   * the last test below is about the owner's own hour.
   */
  await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, {
    user_id: studio.owner.userId,
  });
  await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
    location_ids: [locationId],
  });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: studio.specialistId,
    location_id: locationId,
    effective_from: "2026-08-01",
    intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
  });

  clientId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/clients", {
      name: "Мария",
      phone: "+373 69 777 888",
      email: "maria@studio.example",
    }),
  ).id;
}, 60_000);

afterEach(() => {
  setNotificationProvider(null);
  sent.length = 0;
});

afterAll(async () => {
  await closeTestConnections();
});

function capturingProvider() {
  setNotificationProvider({
    name: "capture",
    async send(message) {
      sent.push(message);
      return { ok: true, providerMessageId: `capture:${sent.length}` };
    },
  });
}

/** A card somebody can be booked into, with an inbox of its own behind it. */
async function bookableMaster(name: string, email: string) {
  const account = await inviteMember(studio.owner, email, "master");
  const cardId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/specialists", {
      name,
      cooperation_type: "commission",
      default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
    }),
  ).id;
  await studio.owner.patch(`/api/v1/specialists/${cardId}`, { user_id: account.userId });
  await studio.owner.put(`/api/v1/specialists/${cardId}/locations`, { location_ids: [locationId] });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: cardId,
    location_id: locationId,
    effective_from: "2026-08-01",
    intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
  });
  return { cardId, account };
}

/**
 * An hour on a Wednesday ahead, counted from today rather than written down:
 * see `tests/helpers/calendar.ts` on what a fixed date costs.
 *
 * Each test takes a week and an hour of its own, so no two compete for one
 * slot — the studio works one weekday here, and a conflict would read as a
 * missing message rather than as the collision it is. 09:00 UTC is midday in
 * Chișinău, comfortably inside the rota.
 */
function deskSlot(week: number, hourUtc: number): string {
  return `${isoDay(weekdayAhead(3, week))}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
}

async function bookAtTheDesk(actor: Actor, specialistCardId: string, startsAt: string) {
  return dataOf<{ id: string; version: number; specialist_id: string }>(
    await actor.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: specialistCardId,
        service_id: studio.serviceId,
        add_on_ids: [],
        client_id: clientId,
        starts_at: startsAt,
      },
      { "idempotency-key": `desk-${crypto.randomUUID()}` },
    ),
  );
}

function noticesFor(bookingId: string) {
  return adminDb.select().from(staffNotices).where(eq(staffNotices.bookingId, bookingId));
}

function queuedFor(bookingId: string, template: string) {
  return adminDb
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.bookingId, bookingId),
        eq(notificationOutbox.template, template),
      ),
    );
}

/** The studio's own messages link into the application, never to a manage page. */
function studioMessagesAbout(bookingId: string) {
  return sent.filter((message) => message.body.includes(`/app/calendar/${bookingId}`));
}

describe("an hour the studio filled from the desk", () => {
  test("reaches the master whose chair it is", async () => {
    const booking = await bookAtTheDesk(studio.owner, irina.cardId, deskSlot(1, 9));

    const notices = await noticesFor(booking.id);
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe("staff_booked");
    expect(notices[0].specialistId).toBe(irina.cardId);
    // Recorded against whoever pressed the button, which is what keeps the feed
    // from reporting the owner's own afternoon back to them.
    expect(notices[0].actorUserId).toBe(studio.owner.userId);

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    // One reader: the chair, not the room. The owner is usually the person who
    // made the booking, and a salon that books all day at the desk does not
    // want its own work back as mail.
    expect(studioMessagesAbout(booking.id).map((message) => message.destination)).toEqual([
      IRINA_EMAIL,
    ]);
    // And the client still gets theirs, which is the message that already worked.
    expect(sent.map((message) => message.destination)).toContain("maria@studio.example");
  });

  test("shows in the master's bell and not in the bell of whoever booked it", async () => {
    const booking = await bookAtTheDesk(studio.owner, irina.cardId, deskSlot(2, 9));

    const hers = dataOf<{ feed: { booking_id: string; kind: string }[] }>(
      await irina.account.get("/api/v1/notifications"),
    );
    expect(hers.feed.find((line) => line.booking_id === booking.id)?.kind).toBe("staff_booked");

    const theirs = dataOf<{ feed: { booking_id: string }[] }>(
      await studio.owner.get("/api/v1/notifications"),
    );
    expect(theirs.feed.some((line) => line.booking_id === booking.id)).toBe(false);
  });

  test("says nothing to a master who booked it themselves", async () => {
    // A master holds `bookings` at scope "own", so this is their own day being
    // filled by their own hand — the one case with nobody to tell.
    const booking = await bookAtTheDesk(irina.account, irina.cardId, deskSlot(3, 9));

    expect(await queuedFor(booking.id, "booking.staff_assigned")).toHaveLength(0);
    // The line is still written, because the owner may want to see it; it is
    // the reader filter, not the writer, that hides it from Ирина herself.
    const notices = await noticesFor(booking.id);
    expect(notices).toHaveLength(1);
    expect(notices[0].actorUserId).toBe(irina.account.userId);
  });
});

describe("an hour the studio moved off somebody's day", () => {
  test("tells the master the appointment left", async () => {
    const booking = await bookAtTheDesk(studio.owner, irina.cardId, deskSlot(4, 9));
    // Drain what the booking itself queued, so what is left is the move.
    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });
    sent.length = 0;

    await studio.owner.post(`/api/v1/bookings/${booking.id}/reschedule`, {
      starts_at: deskSlot(4, 12),
      specialist_id: olga.cardId,
      version: booking.version,
    });

    const freed = await queuedFor(booking.id, "booking.staff_freed");
    expect(freed).toHaveLength(1);
    // The master and the hour travel in the payload: by the time the queue comes
    // round the booking names Ольга and midday, and this message is about
    // neither.
    expect(freed[0].payload?.recipient).toBe("previous_specialist");
    expect(freed[0].payload?.specialistId).toBe(irina.cardId);

    capturingProvider();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const toIrina = sent.filter((message) => message.destination === IRINA_EMAIL);
    expect(toIrina).toHaveLength(1);
    // Where the client went, which is the half of the news she can act on.
    expect(toIrina[0].body).toContain("Ольга");
    expect(toIrina[0].body).not.toContain("Клиент перенёс");
  });

  test("says nothing about a move inside one master's day", async () => {
    const booking = await bookAtTheDesk(studio.owner, irina.cardId, deskSlot(5, 9));

    await studio.owner.post(`/api/v1/bookings/${booking.id}/reschedule`, {
      starts_at: deskSlot(5, 12),
      version: booking.version,
    });

    // The hour is still hers; `staff_rescheduled` in the feed already says
    // which hour it became.
    expect(await queuedFor(booking.id, "booking.staff_freed")).toHaveLength(0);
    const kinds = (await noticesFor(booking.id)).map((notice) => notice.kind).sort();
    expect(kinds).toEqual(["staff_booked", "staff_rescheduled"]);
  });

  test("says nothing to the master who moved it away themselves", async () => {
    // The owner works a chair too, which is the ordinary shape of a small
    // studio — and the one way the person losing the hour is also the person
    // taking it away. A Master cannot reach this case: their scope stops them
    // moving an appointment onto a colleague's card at all.
    const booking = await bookAtTheDesk(studio.owner, studio.specialistId, deskSlot(6, 9));

    await studio.owner.post(`/api/v1/bookings/${booking.id}/reschedule`, {
      starts_at: deskSlot(6, 12),
      specialist_id: olga.cardId,
      version: booking.version,
    });

    // Their own decision, made on the screen that shows it. Ольга's day gained
    // an hour and hers is the only inbox with news in it.
    expect(await queuedFor(booking.id, "booking.staff_freed")).toHaveLength(0);
    expect(await queuedFor(booking.id, "booking.staff_assigned")).toHaveLength(0);
  });
});
