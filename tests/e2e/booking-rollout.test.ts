import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { anonymous, dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The per-organization feature flag of roadmap section 7.11, and the rollback
 * of section 7 that rides on it.
 *
 * "Все новые public и calendar routes закрыты feature flags до прохождения
 * security и concurrency gates" is a claim about every route, not about the one
 * a reviewer happens to open — so the levels are checked from the outside, at
 * the endpoints, rather than by reading the guard.
 */
describe("booking rollout levels", () => {
  let studio: Studio;
  let locationId: string;
  let manageToken: string;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  async function setLevel(level: "off" | "calendar" | "public") {
    await adminDb
      .update(organizations)
      .set({ bookingAccess: level })
      .where(eq(organizations.id, studio.organizationId));
  }

  function nextWednesday(weeksAhead = 1) {
    const day = new Date();
    day.setUTCHours(9, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7 * weeksAhead);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    return day;
  }

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("rollout-owner@studio.example", "Rollout Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "rollout-studio" });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "rollout-centru",
        timezone: "Europe/Chisinau",
      }),
    ).id;
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "07:00", end: "21:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
    });
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    await closeTestConnections();
  });

  test("a new organization gets the calendar and not the public page", async () => {
    // The default the migration ships: every studio that exists already has the
    // calendar, and none of them has a page strangers can reach.
    const [organization] = await adminDb
      .select({ level: organizations.bookingAccess })
      .from(organizations)
      .where(eq(organizations.id, studio.organizationId));
    expect(organization.level).toBe("calendar");

    const bookings = await studio.owner.get("/api/v1/bookings");
    expect(bookings.status).toBe(200);

    // Published location, published slug, environment flag on — and still no
    // page, because this tenant has not been through the gates.
    const page = await anonymous.get("/api/v1/public/booking/rollout-studio");
    expect(page.status).toBe(404);
    expect(errorCodeOf(page)).toBe("BOOKING_PAGE_NOT_FOUND");
  });

  test("raising the level opens the public page and lowering it closes it", async () => {
    await setLevel("public");
    const page = await anonymous.get("/api/v1/public/booking/rollout-studio");
    expect(page.status).toBe(200);

    const slots = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/rollout-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${nextWednesday().toISOString().slice(0, 10)}`,
      ),
    );
    const slot = slots.slots[0];
    const held = dataOf<{ hold_token: string }>(
      await anonymous.post("/api/v1/public/booking/rollout-studio/holds", {
        location_id: locationId,
        service_id: studio.serviceId,
        add_on_ids: [],
        specialist_id: slot.specialist_id,
        starts_at: slot.starts_at,
      }),
    );
    manageToken = dataOf<{ manage_token: string }>(
      await anonymous.post(
        "/api/v1/public/booking/rollout-studio/bookings",
        {
          hold_token: held.hold_token,
          service_id: studio.serviceId,
          add_on_ids: [],
          name: "Ольга",
          phone: "+373 69 424 242",
          email: null,
          locale: "ru",
          legal_accepted: true,
        },
        { "idempotency-key": `rollout-${crypto.randomUUID()}` },
      ),
    ).manage_token;

    expect((await anonymous.get(`/api/v1/public/bookings/${manageToken}`)).status).toBe(200);

    // Rolled back to the calendar: the page and the client's own link both go
    // dark, and the appointment stays exactly where it is.
    await setLevel("calendar");
    expect((await anonymous.get("/api/v1/public/booking/rollout-studio")).status).toBe(404);
    expect((await anonymous.get(`/api/v1/public/bookings/${manageToken}`)).status).toBe(404);
    expect((await anonymous.post(`/api/v1/public/bookings/${manageToken}/cancel`, { version: 1 })).status).toBe(404);
    expect((await studio.owner.get("/api/v1/bookings")).status).toBe(200);
  });

  test("switching the module off closes the calendar too, without losing anything", async () => {
    await setLevel("off");

    const list = await studio.owner.get("/api/v1/bookings");
    expect(list.status).toBe(404);
    expect(errorCodeOf(list)).toBe("BOOKING_DISABLED");

    const created = await studio.owner.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        starts_at: nextWednesday(2).toISOString(),
      },
      { "idempotency-key": `off-${crypto.randomUUID()}` },
    );
    expect(errorCodeOf(created)).toBe("BOOKING_DISABLED");

    // Nothing was deleted: the visit history and everything else the studio
    // pays for keeps working while the booking module is switched off.
    expect((await studio.owner.get("/api/v1/visits")).status).toBe(200);

    await setLevel("calendar");
    expect((await studio.owner.get("/api/v1/bookings")).status).toBe(200);
  });

  test("an owner may step the module down but not publish it themselves", async () => {
    const down = await studio.owner.patch("/api/v1/organizations/settings", {
      booking_access: "off",
    });
    expect(down.status).toBe(200);
    expect(dataOf<{ booking_access: string }>(down).booking_access).toBe("off");

    // Publishing is what section 7.11 puts behind the security and concurrency
    // gates, so it is an operator action, not a settings toggle.
    const up = await studio.owner.patch("/api/v1/organizations/settings", {
      booking_access: "public",
    });
    expect(up.status).toBe(422);
    expect(errorCodeOf(up)).toBe("VALIDATION_ERROR");

    await setLevel("calendar");
  });
});
