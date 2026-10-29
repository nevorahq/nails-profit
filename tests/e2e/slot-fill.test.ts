import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookings } from "@/db/schema";
import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { isoDay, weekdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createClient, createVisit } from "../helpers/factories";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * «Освободилось время»: from a cancelled appointment, the clients from
 * «Пора позвать» worth writing to, each with the message already written.
 *
 * The ranking and the reads are tested apart (`domain/slot-fill.test.ts`,
 * `tests/integration/slot-fill.test.ts`). What is held here is the endpoint:
 * who may ask, and which appointments are an hour at all.
 */
type Booking = { id: string; version: number; status: string };
type Offer = {
  booking_id: string;
  starts_at: string;
  timezone: string;
  specialist_name: string;
  booking_path: string | null;
  clients: {
    client_id: string;
    name: string;
    phone: string;
    last_visit_day: string;
    interval_days: number;
    days_since_last_visit: number;
    message: string;
  }[];
};

const ZONE = "Europe/Chisinau";
const DAY = 24 * 60 * 60 * 1000;

let studio: Studio;
let master: Actor;
let stranger: Actor;
let analyst: Actor;
let locationId: string;
let dueClientId: string;
let nextSlot = 0;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("slotfill-owner@studio.example", "Slot Fill Studio");
  master = await inviteMember(studio.owner, "slotfill-master@studio.example", "master");
  stranger = await inviteMember(studio.owner, "slotfill-stranger@studio.example", "master");
  analyst = await inviteMember(studio.owner, "slotfill-analyst@studio.example", "analyst");
  await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

  locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "slotfill-centru", timezone: ZONE }),
  ).id;
  await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, { location_ids: [locationId] });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: studio.specialistId,
    location_id: locationId,
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })),
    effective_from: "2026-08-01",
  });

  // Past her own rhythm by ten days: twenty days between visits, the last thirty days ago.
  const client = await createClient(studio.organizationId, { name: "Анна", normalizedPhone: "+37369123456" });
  dueClientId = client.id;
  for (const days of [70, 50, 30]) {
    await createVisit(studio.organizationId, {
      specialistId: studio.specialistId,
      clientId: client.id,
      serviceId: studio.serviceId,
      completedAt: new Date(Date.now() - days * DAY),
    });
  }
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

/** An appointment of its own hour each time, so none collides with another. */
async function book(): Promise<Booking> {
  nextSlot += 1;
  return dataOf<Booking>(
    await studio.owner.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        starts_at: `${isoDay(weekdayAhead(3, nextSlot))}T08:00:00.000Z`,
      },
      { "idempotency-key": `slotfill-${crypto.randomUUID()}` },
    ),
  );
}

async function cancelled(): Promise<Booking> {
  const created = await book();
  const response = await studio.owner.post(`/api/v1/bookings/${created.id}/cancel`, {
    reason: "client_request",
    cancelled_by: "client",
    version: created.version,
  });
  expect(response.status).toBe(200);
  return created;
}

describe("the hour a cancellation gave back", () => {
  test("lists the client past her rhythm with a message that names the hour, the master and the service", async () => {
    const freed = await cancelled();

    const response = await studio.owner.get(`/api/v1/bookings/${freed.id}/slot-fill`);
    expect(response.status).toBe(200);
    const offer = dataOf<Offer>(response);

    expect(offer.booking_id).toBe(freed.id);
    expect(offer.timezone).toBe(ZONE);
    expect(offer.clients).toHaveLength(1);
    expect(offer.clients[0]).toMatchObject({
      client_id: dueClientId,
      name: "Анна",
      phone: "+37369123456",
      interval_days: 20,
      days_since_last_visit: 30,
    });
    expect(offer.clients[0].message).toContain("Анна");
    expect(offer.clients[0].message).toContain("Slot Fill Studio");
    expect(offer.specialist_name.length).toBeGreaterThan(0);
    expect(offer.clients[0].message).toContain(offer.specialist_name);
  });

  test("asks to write back while the studio has no published booking page", async () => {
    const freed = await cancelled();
    const offer = dataOf<Offer>(await studio.owner.get(`/api/v1/bookings/${freed.id}/slot-fill`));

    expect(offer.booking_path).toBeNull();
    expect(offer.clients[0].message).not.toContain("__BOOKING_LINK__");
    expect(offer.clients[0].message).toContain("Ответьте");
  });

  test("an appointment still held has no hour to offer", async () => {
    const held = await book();

    const response = await studio.owner.get(`/api/v1/bookings/${held.id}/slot-fill`);
    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("BOOKING_NOT_CANCELLED");
  });

  test("a cancelled appointment that has already begun has none either", async () => {
    const freed = await cancelled();
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await adminDb
      .update(bookings)
      .set({ startsAt: past, endsAt: new Date(past.getTime() + 60 * 60_000) })
      .where(eq(bookings.id, freed.id));

    const response = await studio.owner.get(`/api/v1/bookings/${freed.id}/slot-fill`);
    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("BOOKING_IN_PAST");
  });

  test("an hour somebody has booked again is no longer offered", async () => {
    const freed = await cancelled();
    const [row] = await adminDb.select().from(bookings).where(eq(bookings.id, freed.id));
    const taken = await studio.owner.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        starts_at: row.startsAt.toISOString(),
      },
      { "idempotency-key": `slotfill-${crypto.randomUUID()}` },
    );
    expect(taken.status).toBe(201);

    const response = await studio.owner.get(`/api/v1/bookings/${freed.id}/slot-fill`);
    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("SLOT_UNAVAILABLE");
  });

  test("an appointment that does not exist is a 404", async () => {
    const response = await studio.owner.get(`/api/v1/bookings/${crypto.randomUUID()}/slot-fill`);
    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("BOOKING_NOT_FOUND");
  });
});

describe("who may ask", () => {
  let freed: Booking;

  beforeAll(async () => {
    freed = await cancelled();
  });

  test("the master whose hour it was may; a master with none of their own is told it does not exist", async () => {
    expect((await master.get(`/api/v1/bookings/${freed.id}/slot-fill`)).status).toBe(200);

    const foreign = await stranger.get(`/api/v1/bookings/${freed.id}/slot-fill`);
    expect(foreign.status).toBe(404);
    expect(errorCodeOf(foreign)).toBe("BOOKING_NOT_FOUND");
  });

  test("an analyst writes to nobody, so is offered nobody", async () => {
    expect((await analyst.get(`/api/v1/bookings/${freed.id}/slot-fill`)).status).toBe(403);
  });
});
