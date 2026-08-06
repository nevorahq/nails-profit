import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { anonymous, dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The path from a studio that has nothing to a page a client can book on,
 * walked in the order and with the requests the setup screen makes.
 *
 * The screen is what this is really about. Sections 7.1 and 7.4 shipped these
 * endpoints and nothing in the interface called them: an owner had specialists
 * and services, no address, no working hours, and no way to add either. The
 * public page was unreachable for anyone without a terminal, and every pilot
 * rehearsal was set up by hand — which is exactly why nobody noticed.
 *
 * There is no renderer in this repository, so a test cannot click the form. It
 * can do the next most useful thing: make the same five calls in the same
 * order, with the same payloads the component builds, and check that what comes
 * out the far end is a bookable slot. What that pins is the contract between
 * the screen and the endpoints — a renamed field or a changed enum breaks here
 * rather than in front of a studio owner.
 */
describe("setting booking up from an empty studio", () => {
  let studio: Studio;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  function nextWednesday() {
    const day = new Date();
    day.setUTCHours(9, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    return day;
  }

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("setup-owner@studio.example", "Setup Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "setup-studio" });
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    await closeTestConnections();
  });

  test("an owner reaches a bookable page without leaving the interface", async () => {
    // Nothing set up yet: the page does not exist even for a studio whose slug
    // is right, which is the state every new organization starts in.
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));
    expect((await anonymous.get("/api/v1/public/booking/setup-studio")).status).toBe(404);

    // 1. The address. The screen sends exactly these four fields.
    const created = await studio.owner.post("/api/v1/locations", {
      name: "Центр",
      slug: "setup-centru",
      address: "str. Ismail 33",
      timezone: "Europe/Chisinau",
    });
    expect(created.status).toBe(201);
    const locationId = dataOf<{ id: string }>(created).id;

    // A location alone is not a page: its settings start as a draft, and the
    // checklist on the screen says so before the owner goes looking.
    expect((await anonymous.get("/api/v1/public/booking/setup-studio")).status).toBe(404);

    // 2. The settings, as the form submits them — every field at once, so a
    // studio that changes one thing does not silently reset the rest.
    const settings = await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
      slot_step_minutes: 30,
      min_lead_minutes: 0,
      max_advance_days: 60,
      buffer_before_minutes: 0,
      buffer_after_minutes: 10,
      confirmation_mode: "instant",
      confirmation_ttl_minutes: 120,
      verification_mode: "off",
      verification_ttl_minutes: 10,
      reminder_lead_minutes: 1_440,
    });
    expect(settings.status).toBe(200);

    // The page exists now, and says which address a client may choose.
    const profile = await anonymous.get("/api/v1/public/booking/setup-studio");
    expect(profile.status).toBe(200);
    expect(dataOf<{ locations: { id: string }[] }>(profile).locations).toHaveLength(1);

    // 3. Which addresses the specialist works at.
    const assigned = await studio.owner.put(
      `/api/v1/specialists/${studio.specialistId}/locations`,
      { location_ids: [locationId] },
    );
    expect(assigned.status).toBe(200);

    // 4. The rota, in the shape the weekday rows produce: only the ticked days,
    // local `HH:MM`, and the date the pattern starts applying.
    const rota = await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      effective_from: new Date().toISOString().slice(0, 10),
      intervals: [
        { weekday: 3, start: "09:00", end: "18:00" },
        { weekday: 4, start: "09:00", end: "18:00" },
      ],
    });
    expect(rota.status).toBe(201);

    // And a client can be offered a time.
    const date = nextWednesday().toISOString().slice(0, 10);
    const availability = await anonymous.get(
      `/api/v1/public/booking/setup-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${date}`,
    );
    expect(availability.status).toBe(200);
    expect(dataOf<{ slots: unknown[] }>(availability).slots.length).toBeGreaterThan(0);
  });

  test("the rota the screen reads back is the one it saved", async () => {
    // The editor pre-fills its rows from this endpoint, so the round trip is
    // what decides whether reopening the page shows Wednesday or an empty form.
    const rules = dataOf<
      { weekday: number; start_minute: number; end_minute: number; location_id: string }[]
    >(await studio.owner.get(`/api/v1/availability/rules?specialist_id=${studio.specialistId}`));

    expect(rules.map((rule) => rule.weekday)).toEqual([3, 4]);
    // 09:00 and 18:00 as the minutes since local midnight the form converts to.
    expect(rules.every((rule) => rule.start_minute === 540 && rule.end_minute === 1_080)).toBe(true);
  });

  test("a saved rota replaces the previous one instead of adding to it", async () => {
    // The form always submits the whole week, so saving Thursday off has to
    // mean Thursday off — not Thursday twice.
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: dataOf<{ id: string }[]>(await studio.owner.get("/api/v1/locations"))[0].id,
      effective_from: new Date().toISOString().slice(0, 10),
      intervals: [{ weekday: 3, start: "10:00", end: "16:00" }],
    });

    const rules = dataOf<{ weekday: number; start_minute: number }[]>(
      await studio.owner.get(`/api/v1/availability/rules?specialist_id=${studio.specialistId}`),
    );

    expect(rules.map((rule) => rule.weekday)).toEqual([3]);
    expect(rules[0].start_minute).toBe(600);
  });

  test("the screen cannot publish a page the module is switched off for", async () => {
    // Section 7.11: the setup screen is a calendar surface like any other, and
    // an organization rolled back to `off` does not keep taking configuration.
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "off" })
      .where(eq(organizations.id, studio.organizationId));

    const refused = await studio.owner.post("/api/v1/locations", {
      name: "Второй",
      slug: "setup-second",
      timezone: "Europe/Chisinau",
    });
    expect(errorCodeOf(refused)).toBe("BOOKING_DISABLED");

    // Reading the setup still works, which is what the read-only calendar is.
    expect((await studio.owner.get("/api/v1/locations")).status).toBe(200);

    await adminDb
      .update(organizations)
      .set({ bookingAccess: "calendar" })
      .where(eq(organizations.id, studio.organizationId));
  });
});
