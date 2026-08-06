import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { anonymous, dataOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

describe("public booking UX contract", () => {
  let studio: Studio;
  let locationId: string;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("booking-ux@studio.example", "Booking UX Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "booking-ux" });
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Centru",
        slug: "centru",
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
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
      max_advance_days: 90,
    });
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    await closeTestConnections();
  });

  test("an empty day returns the nearest available dates without exposing the rota", async () => {
    const availability = dataOf<{
      timezone: string;
      slots: unknown[];
      nearest_dates: { date: string; slot_count: number }[];
    }>(
      await anonymous.get(
        `/api/v1/public/booking/booking-ux/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=2026-09-01`,
      ),
    );

    expect(availability.timezone).toBe("Europe/Chisinau");
    expect(availability.slots).toEqual([]);
    expect(availability.nearest_dates[0]).toEqual({
      date: "2026-09-02",
      slot_count: expect.any(Number),
    });
    expect(availability.nearest_dates[0].slot_count).toBeGreaterThan(0);
    expect(availability.nearest_dates).toHaveLength(3);
  });
});
