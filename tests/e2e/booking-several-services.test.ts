import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookingLines, bookings, financialSnapshots, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";

import { anonymous, dataOf, errorCodeOf } from "../helpers/api";
import { wednesdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createAddOn, createCommissionRule } from "../helpers/factories";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

type Line = { kind: string; service_id: string | null; add_on_id: string | null; price_minor: number };
type Booking = {
  id: string;
  version: number;
  starts_at: string;
  ends_at: string;
  price_minor: number;
  lines: Line[];
};

/**
 * An appointment of several services, taken at the desk.
 *
 * Canonical studio — a 600 MDL manicure for 90 minutes at 40% — plus a 400 MDL
 * pedicure for 60 minutes the master is paid a flat 150 for, and a 100 MDL
 * design of 15 minutes. One sitting is booked as one interval, and closing it
 * must cost exactly what entering the same visit by hand costs.
 */
describe("an appointment of several services", () => {
  let studio: Studio;
  let locationId: string;
  let pedicureId: string;
  let designId: string;
  let colleagueId: string;
  let slot = 0;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  const PEDICURE_PRICE = 40_000;
  const PEDICURE_MINUTES = 60;
  const FLAT = 15_000;

  function nextSlot() {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    day.setUTCDate(day.getUTCDate() + 7 * Math.floor(slot / 4));
    day.setUTCHours(5 + 3 * (slot % 4));
    slot += 1;
    return day.toISOString();
  }

  async function alreadyHappened(bookingId: string) {
    const [row] = await adminDb
      .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    const shift = row.startsAt.getTime() - (Date.now() - 3 * 60 * 60_000);
    await adminDb
      .update(bookings)
      .set({ startsAt: new Date(row.startsAt.getTime() - shift), endsAt: new Date(row.endsAt.getTime() - shift) })
      .where(eq(bookings.id, bookingId));
  }

  async function book(body: Record<string, unknown>) {
    return studio.owner.post(
      "/api/v1/bookings",
      { location_id: locationId, specialist_id: studio.specialistId, starts_at: nextSlot(), ...body },
      { "idempotency-key": crypto.randomUUID() },
    );
  }

  async function snapshotOf(visitId: string) {
    const [snapshot] = await withTenant(studio.organizationId, (tx) =>
      tx
        .select()
        .from(financialSnapshots)
        .where(eq(financialSnapshots.visitId, visitId))
        .orderBy(desc(financialSnapshots.snapshotVersion))
        .limit(1),
    );
    return snapshot;
  }

  const minutesOf = (booking: Pick<Booking, "starts_at" | "ends_at">) =>
    (new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 60_000;

  const sitting = () => [
    { service_id: studio.serviceId, add_on_ids: [designId] },
    { service_id: pedicureId, add_on_ids: [] },
  ];

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("several-booking@studio.example", "Several Booking Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "several-booking" });
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));

    pedicureId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/services", {
        name: { ru: "Педикюр" },
        price_minor: PEDICURE_PRICE,
        duration_minutes: PEDICURE_MINUTES,
      }),
    ).id;
    await createCommissionRule(studio.organizationId, studio.specialistId, {
      type: "fixed",
      fixedAmountMinor: FLAT,
      serviceId: pedicureId,
      activeFrom: new Date(Date.now() - 24 * 60 * 60_000),
    });
    designId = (
      await createAddOn(studio.organizationId, { name: "Дизайн", priceDeltaMinor: 10_000, durationDeltaMinutes: 15 })
    ).id;

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "several-centru",
        timezone: "Europe/Chisinau",
      }),
    ).id;

    colleagueId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Коллега",
        default_rule: { type: "percentage", basis_points: 3_000 },
      }),
    ).id;
    for (const specialistId of [studio.specialistId, colleagueId]) {
      await studio.owner.put(`/api/v1/specialists/${specialistId}/locations`, { location_ids: [locationId] });
      await studio.owner.put("/api/v1/availability/rules", {
        specialist_id: specialistId,
        location_id: locationId,
        intervals: [{ weekday: 3, start: "07:00", end: "21:00" }],
        effective_from: new Date().toISOString().slice(0, 10),
      });
    }
    // The colleague does manicures, not pedicures.
    await studio.owner.put(`/api/v1/specialists/${colleagueId}/services`, {
      services: [{ service_id: studio.serviceId }],
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

  test("is one interval as long as all of it, priced as all of it", async () => {
    const response = await book({ services: sitting() });
    expect(response.status).toBe(201);
    const booking = dataOf<Booking>(response);

    expect(minutesOf(booking)).toBe(CANONICAL.serviceDurationMinutes + 15 + PEDICURE_MINUTES);
    expect(booking.price_minor).toBe(CANONICAL.servicePriceMinor + 10_000 + PEDICURE_PRICE);
    // The design names the manicure it was chosen for.
    expect(booking.lines.find((line) => line.kind === "add_on")).toMatchObject({
      add_on_id: designId,
      service_id: studio.serviceId,
    });
    expect(booking.lines.filter((line) => line.kind === "service").map((line) => line.service_id)).toEqual([
      studio.serviceId,
      pedicureId,
    ]);
  });

  test("is refused for a master who does not do every service of it", async () => {
    const response = await book({ specialist_id: colleagueId, services: sitting() });
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("SERVICE_NOT_OFFERED");

    const manicureOnly = await book({
      specialist_id: colleagueId,
      services: [{ service_id: studio.serviceId, add_on_ids: [] }],
    });
    expect(manicureOnly.status).toBe(201);
  });

  test("closes into the same snapshot as the visit entered by hand", async () => {
    for (const paid of [undefined, 100_000, 125_000]) {
      const booking = dataOf<Booking>(await book({ services: sitting() }));
      await alreadyHappened(booking.id);

      const closed = await studio.owner.post(
        `/api/v1/bookings/${booking.id}/complete`,
        { version: booking.version, actual_duration_minutes: 165, ...(paid === undefined ? {} : { paid_minor: paid }) },
        { "idempotency-key": crypto.randomUUID() },
      );
      expect(closed.status).toBe(201);
      const fromBooking = await snapshotOf(dataOf<{ visit: { id: string } }>(closed).visit.id);

      const manual = await studio.owner.post("/api/v1/visits", {
        specialist_id: studio.specialistId,
        services: sitting(),
        actual_duration_minutes: 165,
        ...(paid === undefined ? {} : { paid_minor: paid }),
      });
      const byHand = await snapshotOf(dataOf<{ id: string }>(manual).id);

      for (const field of [
        "revenueMinor",
        "commissionMinor",
        "contributionMarginMinor",
        "profitPerHourMinor",
        "formulaVersion",
      ] as const) {
        expect(fromBooking[field]).toEqual(byHand[field]);
      }
      // 40% of the manicure with its design, the flat 150 for the pedicure.
      if (paid === undefined) expect(fromBooking.commissionMinor).toBe(28_000 + FLAT);
      expect(fromBooking.revenueMinor).toBe(paid ?? 110_000);
    }
  });

  test("cannot be handed to a colleague who does not do every service of it", async () => {
    const booking = dataOf<Booking>(await book({ services: sitting() }));
    const moved = await studio.owner.post(`/api/v1/bookings/${booking.id}/reschedule`, {
      starts_at: booking.starts_at,
      specialist_id: colleagueId,
      version: booking.version,
    });
    expect(moved.status).toBe(422);
    expect(errorCodeOf(moved)).toBe("SERVICE_NOT_OFFERED");
  });

  test("keeps its whole length when the client moves it from their link", async () => {
    // Booked on the public page as one service, then given a second at the desk
    // the way an appointment of several services is: one sitting, two lines.
    const offered = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/several-booking/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=${studio.specialistId}&date=${wednesdayAhead(5)}`,
      ),
    ).slots[0];
    const held = dataOf<{ hold_token: string }>(
      await anonymous.post("/api/v1/public/booking/several-booking/holds", {
        location_id: locationId,
        service_id: studio.serviceId,
        add_on_ids: [],
        specialist_id: offered.specialist_id,
        starts_at: offered.starts_at,
      }),
    );
    const created = dataOf<{ id: string; manage_token: string }>(
      await anonymous.post(
        "/api/v1/public/booking/several-booking/bookings",
        {
          hold_token: held.hold_token,
          service_id: studio.serviceId,
          add_on_ids: [],
          name: "Анна",
          phone: "+373 69 555 123",
          email: null,
          contact_channels: [],
          locale: "ru",
          legal_accepted: true,
        },
        { "idempotency-key": `create-${crypto.randomUUID()}` },
      ),
    );
    const [row] = await adminDb.select().from(bookings).where(eq(bookings.id, created.id));
    await adminDb.insert(bookingLines).values({
      organizationId: studio.organizationId,
      bookingId: created.id,
      kind: "service",
      serviceId: pedicureId,
      nameSnapshot: { ru: "Педикюр" },
      priceMinor: PEDICURE_PRICE,
      durationMinutes: PEDICURE_MINUTES,
    });
    await adminDb
      .update(bookings)
      .set({ endsAt: new Date(row.endsAt.getTime() + PEDICURE_MINUTES * 60_000) })
      .where(eq(bookings.id, created.id));

    const manage = dataOf<{ version: number; services: { service_id: string; add_on_ids: string[] }[] }>(
      await anonymous.get(`/api/v1/public/bookings/${created.manage_token}`),
    );
    expect(manage.services.map((item) => item.service_id)).toEqual([studio.serviceId, pedicureId]);

    // The times offered for the move fit the whole sitting.
    const services = manage.services.map((item) => [item.service_id, ...item.add_on_ids].join(":")).join("|");
    const slots = dataOf<{ slots: { starts_at: string; specialist_id: string; duration_minutes: number }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/several-booking/availability?location_id=${locationId}&service_id=${studio.serviceId}&services=${services}&specialist_id=any&date=${wednesdayAhead(6)}`,
      ),
    ).slots;
    expect(slots.length).toBeGreaterThan(0);
    // The colleague does not do pedicures, so only the master is offered.
    expect(new Set(slots.map((entry) => entry.specialist_id))).toEqual(new Set([studio.specialistId]));
    expect(slots[0].duration_minutes).toBe(CANONICAL.serviceDurationMinutes + PEDICURE_MINUTES);

    const moved = dataOf<{ starts_at: string; ends_at: string }>(
      await anonymous.post(
        `/api/v1/public/bookings/${created.manage_token}/reschedule`,
        { starts_at: slots[0].starts_at, specialist_id: slots[0].specialist_id, version: manage.version },
        { "idempotency-key": `move-${crypto.randomUUID()}` },
      ),
    );
    expect(minutesOf(moved)).toBe(CANONICAL.serviceDurationMinutes + PEDICURE_MINUTES);
  });

  test("the public availability refuses a malformed list of services", async () => {
    const response = await anonymous.get(
      `/api/v1/public/booking/several-booking/availability?location_id=${locationId}&service_id=${studio.serviceId}&services=not-a-list&date=${wednesdayAhead(6)}`,
    );
    expect(response.status).toBe(422);
  });
});
