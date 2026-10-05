import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookings, notificationOutbox, staffNotices } from "@/db/schema";
import { addLocalDays, formatLocalDate, toZonedParts } from "@/domain/timezone";
import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { isoDay, weekdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * «Следующая запись», roadmap phase 8: from a closed appointment, the same
 * sitting N weeks on, booked through the one staff path naming the visit it
 * follows (`rebooked_from_booking_id`).
 */
type Booking = { id: string; version: number; status: string; source: string; starts_at: string };
type Suggestion = {
  location_id: string;
  specialist_id: string;
  client_id: string;
  services: { service_id: string; add_on_ids: string[] }[];
  timezone: string;
  target_date: string;
  days: { date: string; slots: string[] }[];
  upcoming_starts_at: string | null;
};

const ZONE = "Europe/Chisinau";

let studio: Studio;
let master: Actor;
let stranger: Actor;
let analyst: Actor;
let locationId: string;
let clientId: string;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("rebook-owner@studio.example", "Rebook Studio");
  master = await inviteMember(studio.owner, "rebook-master@studio.example", "master");
  // A master with no card of their own: every appointment is somebody else's.
  stranger = await inviteMember(studio.owner, "rebook-stranger@studio.example", "master");
  analyst = await inviteMember(studio.owner, "rebook-analyst@studio.example", "analyst");
  await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

  locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "rebook-centru", timezone: ZONE }),
  ).id;
  await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
    location_ids: [locationId],
  });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: studio.specialistId,
    location_id: locationId,
    // Every day, so «через N недель» always lands on a working one.
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })),
    effective_from: "2026-08-01",
  });

  clientId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/clients", { name: "Мария", email: "rebook-maria@studio.example" }),
  ).id;
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

async function book(body: Record<string, unknown> = {}, actor: Actor = studio.owner): Promise<Booking> {
  return dataOf<Booking>(
    await actor.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        client_id: clientId,
        starts_at: `${isoDay(weekdayAhead(3, 1))}T08:00:00.000Z`,
        ...body,
      },
      { "idempotency-key": `rebook-${crypto.randomUUID()}` },
    ),
  );
}

/**
 * Moves an appointment into the past and closes it, as the desk would. Each
 * caller takes an hour of its own: two closed visits of one master at the same
 * time are refused by the exclusion constraint, like any double booking.
 */
async function closed(body: Record<string, unknown> = {}, hoursAgo = 2): Promise<Booking> {
  const created = await book(body);
  const startsAt = new Date(Date.now() - hoursAgo * 60 * 60_000);
  await adminDb
    .update(bookings)
    .set({ startsAt, endsAt: new Date(startsAt.getTime() + 90 * 60_000) })
    .where(eq(bookings.id, created.id));
  const completed = await studio.owner.post(`/api/v1/bookings/${created.id}/complete`, {
    version: created.version,
  });
  expect(completed.status).toBe(201);
  return { ...created, starts_at: startsAt.toISOString() };
}

describe("the next appointment from a closed one", () => {
  let visit: Booking;
  let suggestion: Suggestion;

  beforeAll(async () => {
    visit = await closed();
    suggestion = dataOf<Suggestion>(
      await studio.owner.get(`/api/v1/bookings/${visit.id}/next-slots?weeks=3`),
    );
  });

  test("offers the same sitting, searched from three weeks after the visit", () => {
    const local = toZonedParts(new Date(visit.starts_at), ZONE);
    expect(suggestion.target_date).toBe(formatLocalDate(addLocalDays(local, 21)));
    expect(suggestion.specialist_id).toBe(studio.specialistId);
    expect(suggestion.location_id).toBe(locationId);
    expect(suggestion.client_id).toBe(clientId);
    expect(suggestion.services).toEqual([{ service_id: studio.serviceId, add_on_ids: [] }]);

    expect(suggestion.days.length).toBeGreaterThan(0);
    expect(suggestion.days[0].date >= suggestion.target_date).toBe(true);
    expect(suggestion.days[0].slots.length).toBeGreaterThan(0);
    expect(suggestion.upcoming_starts_at).toBeNull();
  });

  test("is booked confirmed, as rebooking, and told to the client like any desk booking", async () => {
    const startsAt = suggestion.days[0].slots[0];
    const created = await book({
      services: suggestion.services,
      service_id: undefined,
      starts_at: startsAt,
      rebooked_from_booking_id: visit.id,
    });

    expect(created.status).toBe("confirmed");
    expect(created.source).toBe("rebooking");

    const [row] = await adminDb.select().from(bookings).where(eq(bookings.id, created.id));
    expect(row.source).toBe("rebooking");
    expect(row.rebookedFromBookingId).toBe(visit.id);

    // The same messages the staff path writes: the client's confirmation and
    // the line in the master's feed.
    const queued = await adminDb
      .select()
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.bookingId, created.id), eq(notificationOutbox.template, "booking.confirmed")));
    expect(queued.length).toBeGreaterThan(0);
    const notices = await adminDb.select().from(staffNotices).where(eq(staffNotices.bookingId, created.id));
    expect(notices.map((notice) => notice.kind)).toContain("staff_booked");

    // And the next ask knows the client is already coming back.
    const again = dataOf<Suggestion>(await studio.owner.get(`/api/v1/bookings/${visit.id}/next-slots?weeks=2`));
    expect(again.upcoming_starts_at).toBe(startsAt);
    // Nor is the time just taken offered again.
    expect(again.days.flatMap((day) => day.slots)).not.toContain(startsAt);
  });

  test("a booking that says nothing about its source is a desk booking", async () => {
    const created = await book({ starts_at: `${isoDay(weekdayAhead(3, 8))}T08:00:00.000Z` });
    expect(created.source).toBe("staff");
  });

  test("the master whose appointment it was may ask; a master with none of their own may not see it", async () => {
    expect((await master.get(`/api/v1/bookings/${visit.id}/next-slots?weeks=4`)).status).toBe(200);

    const foreign = await stranger.get(`/api/v1/bookings/${visit.id}/next-slots?weeks=4`);
    expect(foreign.status).toBe(404);
    expect(errorCodeOf(foreign)).toBe("BOOKING_NOT_FOUND");
  });

  test("an analyst books nobody, so is offered nothing", async () => {
    expect((await analyst.get(`/api/v1/bookings/${visit.id}/next-slots?weeks=3`)).status).toBe(403);
  });

  test("weeks outside one to twelve are refused", async () => {
    for (const weeks of ["0", "13", "two", ""]) {
      const response = await studio.owner.get(`/api/v1/bookings/${visit.id}/next-slots?weeks=${weeks}`);
      expect(response.status).toBe(422);
      expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
    }
  });
});

describe("a rebooking names a visit it really followed", () => {
  let other: string;

  beforeAll(async () => {
    other = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/clients", { name: "Другая", email: "rebook-other@studio.example" }),
    ).id;
  });

  async function refused(body: Record<string, unknown>, actor: Actor = studio.owner) {
    const response = await actor.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        client_id: clientId,
        starts_at: `${isoDay(weekdayAhead(3, 11))}T08:00:00.000Z`,
        ...body,
      },
      { "idempotency-key": `rebook-refused-${crypto.randomUUID()}` },
    );
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("REBOOKED_FROM_INVALID");
  }

  test("not one that has not been closed", async () => {
    const open = await book({ starts_at: `${isoDay(weekdayAhead(3, 12))}T08:00:00.000Z` });
    await refused({ rebooked_from_booking_id: open.id });
  });

  test("not another client's visit", async () => {
    const visit = await closed({ starts_at: `${isoDay(weekdayAhead(3, 13))}T08:00:00.000Z` }, 8);
    await refused({ rebooked_from_booking_id: visit.id, client_id: other });
  });

  test("not an id that names nothing", async () => {
    await refused({ rebooked_from_booking_id: crypto.randomUUID() });
  });
});

describe("what is not booked again", () => {
  test("an appointment that has not been closed", async () => {
    const open = await book({ starts_at: `${isoDay(weekdayAhead(3, 9))}T08:00:00.000Z` });
    const response = await studio.owner.get(`/api/v1/bookings/${open.id}/next-slots?weeks=3`);
    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("BOOKING_NOT_COMPLETED");
  });

  test("an appointment with no client", async () => {
    const anonymous = await closed({ client_id: null, starts_at: `${isoDay(weekdayAhead(3, 10))}T08:00:00.000Z` }, 5);
    const response = await studio.owner.get(`/api/v1/bookings/${anonymous.id}/next-slots?weeks=3`);
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("BOOKING_HAS_NO_CLIENT");
  });
});
