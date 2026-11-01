import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { localToUtc, parseLocalDate, parseLocalTime } from "@/domain/timezone";
import { organizations, specialistServices, visitLines } from "@/db/schema";
import { anonymous, dataOf, errorCodeOf } from "../helpers/api";
import { wednesdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * A master who charges their own price for a service.
 *
 * The service has one list price; a senior master may charge more for the same
 * manicure, and a junior less. The price is set beside the master's own
 * duration, and everything that quotes or records the appointment — a staff
 * booking, a closed visit, the public page's catalogue and times — has to use
 * it, while a master with no price of their own still charges the list.
 */
describe("a master's own price for a service", () => {
  let studio: Studio;
  let seniorId: string;
  let locationId: string;
  const SENIOR_PRICE = 75_000;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  function wednesdayAt(time: string): string {
    return localToUtc(parseLocalDate(wednesdayAhead(1))!, parseLocalTime(time)!, "Europe/Chisinau").toISOString();
  }

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("own-price@studio.example", "Own Price Studio");
    seniorId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Старший мастер",
        default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
      }),
    ).id;

    await studio.owner.patch("/api/v1/organizations/settings", { slug: "own-price" });
    await adminDb.update(organizations).set({ bookingAccess: "public" }).where(eq(organizations.id, studio.organizationId));
    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "own-price-centru", timezone: "Europe/Chisinau" }),
    ).id;
    for (const id of [studio.specialistId, seniorId]) {
      await studio.owner.put(`/api/v1/specialists/${id}/locations`, { location_ids: [locationId] });
      await studio.owner.put("/api/v1/availability/rules", {
        specialist_id: id,
        location_id: locationId,
        intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
        effective_from: "2026-08-01",
      });
    }
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

  test("is stored beside the master's own duration", async () => {
    const response = await studio.owner.put(`/api/v1/specialists/${seniorId}/services`, {
      services: [{ service_id: studio.serviceId, price_minor: SENIOR_PRICE }],
    });
    expect(response.status).toBe(200);

    const [row] = await adminDb
      .select({ price: specialistServices.priceOverrideMinor, duration: specialistServices.durationOverrideMinutes })
      .from(specialistServices)
      .where(eq(specialistServices.specialistId, seniorId));
    expect(row).toEqual({ price: SENIOR_PRICE, duration: null });
  });

  test("refuses a negative price", async () => {
    const response = await studio.owner.put(`/api/v1/specialists/${seniorId}/services`, {
      services: [{ service_id: studio.serviceId, price_minor: -1 }],
    });
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
  });

  test("a staff booking with the master is priced at their price, and with another at the list's", async () => {
    const book = (specialistId: string, time: string) =>
      studio.owner.post(
        "/api/v1/bookings",
        { location_id: locationId, specialist_id: specialistId, service_id: studio.serviceId, starts_at: wednesdayAt(time) },
        { "idempotency-key": crypto.randomUUID() },
      );
    const senior = dataOf<{ id: string }>(await book(seniorId, "10:00"));
    const junior = dataOf<{ id: string }>(await book(studio.specialistId, "10:00"));

    const list = dataOf<{ id: string; lines: { price_minor: number }[] }[]>(await studio.owner.get("/api/v1/bookings"));
    expect(list.find((booking) => booking.id === senior.id)!.lines[0].price_minor).toBe(SENIOR_PRICE);
    expect(list.find((booking) => booking.id === junior.id)!.lines[0].price_minor).toBe(CANONICAL.servicePriceMinor);
  });

  test("a visit closed by hand records the master's price", async () => {
    const close = async (specialistId: string) => {
      const visit = dataOf<{ id: string }>(
        await studio.owner.post("/api/v1/visits", {
          specialist_id: specialistId,
          services: [{ service_id: studio.serviceId, add_on_ids: [] }],
        }),
      );
      const [line] = await adminDb
        .select({ price: visitLines.priceMinor })
        .from(visitLines)
        .where(eq(visitLines.visitId, visit.id));
      return line.price;
    };

    expect(await close(seniorId)).toBe(SENIOR_PRICE);
    expect(await close(studio.specialistId)).toBe(CANONICAL.servicePriceMinor);
  });

  test("the public catalogue says what each master charges", async () => {
    const catalogue = dataOf<{ services: { id: string; specialists: { id: string; price_minor: number }[] }[] }>(
      await anonymous.get(`/api/v1/public/booking/own-price/catalog?location_id=${locationId}`),
    );
    const people = catalogue.services.find((service) => service.id === studio.serviceId)!.specialists;

    expect(people.find((person) => person.id === seniorId)?.price_minor).toBe(SENIOR_PRICE);
    expect(people.find((person) => person.id === studio.specialistId)?.price_minor).toBe(CANONICAL.servicePriceMinor);
  });

  test("the public times with the master carry their price", async () => {
    const timesWith = async (specialistId: string) =>
      dataOf<{ slots: { price_minor: number }[] }>(
        await anonymous.get(
          `/api/v1/public/booking/own-price/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=${specialistId}&date=${wednesdayAhead(2)}`,
        ),
      ).slots;

    const senior = await timesWith(seniorId);
    expect(senior.length).toBeGreaterThan(0);
    expect(new Set(senior.map((slot) => slot.price_minor))).toEqual(new Set([SENIOR_PRICE]));
    const junior = await timesWith(studio.specialistId);
    expect(new Set(junior.map((slot) => slot.price_minor))).toEqual(new Set([CANONICAL.servicePriceMinor]));
  });
});
