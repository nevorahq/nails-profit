import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  auditEvents,
  bookingSettings,
  locations,
  scheduleRules,
  specialistLocations,
} from "@/db/schema";
import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * Removing an address, and refusing to.
 *
 * The rule the endpoint defends is narrow and worth stating twice: an address a
 * client was booked at is a record of where money was earned and is archived,
 * never deleted. An address nobody ever used is a typo, and a product that
 * makes the owner live with their typo forever is being pedantic rather than
 * careful. A booking is the line between the two.
 */
describe("deleting a location", () => {
  let studio: Studio;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("owner@delete.example", "Студия");
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  async function newLocation(slug: string) {
    return dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Зал", slug }),
    ).id;
  }

  test("removes an address nobody has used, and its own configuration with it", async () => {
    const locationId = await newLocation("unused-hall");

    // Settings are created alongside the address by the endpoint itself, and a
    // specialist is assigned — both are `ON DELETE restrict`, so this is what
    // proves the handler clears them rather than leaning on a cascade.
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });

    const response = await studio.owner.delete(`/api/v1/locations/${locationId}`);
    expect(response.status).toBe(200);

    expect(await adminDb.select().from(locations).where(eq(locations.id, locationId))).toHaveLength(0);
    expect(
      await adminDb.select().from(bookingSettings).where(eq(bookingSettings.locationId, locationId)),
    ).toHaveLength(0);
    expect(
      await adminDb
        .select()
        .from(specialistLocations)
        .where(eq(specialistLocations.locationId, locationId)),
    ).toHaveLength(0);
  });

  test("clears a rota that pointed at the address", async () => {
    const locationId = await newLocation("rota-hall");
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "09:00", end: "17:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });

    expect(
      await adminDb.select().from(scheduleRules).where(eq(scheduleRules.locationId, locationId)),
    ).not.toHaveLength(0);

    expect((await studio.owner.delete(`/api/v1/locations/${locationId}`)).status).toBe(200);

    expect(
      await adminDb.select().from(scheduleRules).where(eq(scheduleRules.locationId, locationId)),
    ).toHaveLength(0);
  });

  test("leaves the deleted address readable in the audit trail", async () => {
    const locationId = await newLocation("audited-hall");
    await studio.owner.delete(`/api/v1/locations/${locationId}`);

    const [event] = await adminDb
      .select()
      .from(auditEvents)
      // Creating the address logged one event too; this test is about the other.
      .where(and(eq(auditEvents.entityId, locationId), eq(auditEvents.eventType, "location.deleted")));

    expect(event.eventType).toBe("location.deleted");
    // The row exists nowhere else now, so the event has to carry enough of it
    // to answer what was removed.
    expect((event.before as { slug: string }).slug).toBe("audited-hall");
  });

  test("refuses an address that has a booking, and keeps it", async () => {
    const locationId = await newLocation("busy-hall");
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "09:00", end: "17:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });
    await studio.owner.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        starts_at: "2026-09-02T07:00:00.000Z",
      },
      { "idempotency-key": `delete-${crypto.randomUUID()}` },
    );

    const response = await studio.owner.delete(`/api/v1/locations/${locationId}`);

    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("LOCATION_HAS_BOOKINGS");
    expect(await adminDb.select().from(locations).where(eq(locations.id, locationId))).toHaveLength(1);
  });

  test("refuses an address that is published, and takes it once it is not", async () => {
    const locationId = await newLocation("published-hall");
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
    });

    const refused = await studio.owner.delete(`/api/v1/locations/${locationId}`);
    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe("LOCATION_PUBLISHED");
    expect(await adminDb.select().from(locations).where(eq(locations.id, locationId))).toHaveLength(1);

    // Taking the page down is the separate decision, and the only thing between
    // the two: nobody was ever booked here, so the address is a typo again.
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "paused",
    });

    const removed = await studio.owner.delete(`/api/v1/locations/${locationId}`);
    expect(removed.status).toBe(200);
    expect(await adminDb.select().from(locations).where(eq(locations.id, locationId))).toHaveLength(0);
  });

  test("answers 404 for an address that does not exist", async () => {
    const response = await studio.owner.delete(
      "/api/v1/locations/00000000-0000-4000-8000-000000000000",
    );

    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("LOCATION_NOT_FOUND");
  });
});
