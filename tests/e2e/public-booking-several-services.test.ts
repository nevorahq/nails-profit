import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookingLines, bookings, organizations } from "@/db/schema";

import { anonymous, dataOf, errorCodeOf } from "../helpers/api";
import { wednesdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createAddOn } from "../helpers/factories";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

type Slot = { starts_at: string; ends_at: string; specialist_id: string; duration_minutes: number };
type Item = { service_id: string; add_on_ids: string[] };

/**
 * A client booking several services in one sitting on the public page.
 *
 * Canonical studio: a 600 MDL manicure for 90 minutes. Added: a 400 MDL pedicure
 * for 60, a 200 MDL brow shape for 30, a 100 MDL design of 15 offered with the
 * manicure, and a colleague who does manicures and nothing else. One master,
 * one interval, at most three services.
 */
describe("public booking of several services", () => {
  let studio: Studio;
  let locationId: string;
  let pedicureId: string;
  let browsId: string;
  let lashesId: string;
  let designId: string;
  let colleagueId: string;
  let week = 1;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  const path = (rest: string) => `/api/v1/public/booking/several-public/${rest}`;
  const servicesParam = (items: Item[]) =>
    items.map((item) => [item.service_id, ...item.add_on_ids].join(":")).join("|");

  async function slotsFor(items: Item[], specialist = "any") {
    const query = new URLSearchParams({
      location_id: locationId,
      service_id: items[0].service_id,
      services: servicesParam(items),
      specialist_id: specialist,
      date: wednesdayAhead(week++),
    });
    return dataOf<{ slots: Slot[] }>(await anonymous.get(`${path("availability")}?${query.toString()}`)).slots;
  }

  async function hold(items: Item[], slot: Slot) {
    return anonymous.post(path("holds"), {
      location_id: locationId,
      services: items,
      specialist_id: slot.specialist_id,
      starts_at: slot.starts_at,
    });
  }

  async function book(holdToken: string, items: Item[], phone: string) {
    return anonymous.post(
      path("bookings"),
      {
        hold_token: holdToken,
        services: items,
        name: "Анна",
        phone,
        email: null,
        contact_channels: [],
        locale: "ru",
        legal_accepted: true,
      },
      { "idempotency-key": `create-${crypto.randomUUID()}` },
    );
  }

  const sitting = (): Item[] => [
    { service_id: studio.serviceId, add_on_ids: [designId] },
    { service_id: pedicureId, add_on_ids: [] },
  ];

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("several-public@studio.example", "Several Public");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "several-public" });
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));

    const service = async (name: string, price: number, minutes: number) =>
      dataOf<{ id: string }>(
        await studio.owner.post("/api/v1/services", {
          name: { ru: name },
          price_minor: price,
          duration_minutes: minutes,
        }),
      ).id;
    pedicureId = await service("Педикюр", 40_000, 60);
    browsId = await service("Брови", 20_000, 30);
    lashesId = await service("Ресницы", 30_000, 45);
    designId = (await createAddOn(studio.organizationId, { name: "Дизайн", priceDeltaMinor: 10_000, durationDeltaMinutes: 15 })).id;
    await studio.owner.put(`/api/v1/services/${studio.serviceId}/add-ons`, { add_on_ids: [designId] });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "several-public-centru",
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
        effective_from: "2026-08-01",
        intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
      });
    }
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

  test("is offered, held and booked as one sitting with the one master who does all of it", async () => {
    const slots = await slotsFor(sitting());
    expect(slots.length).toBeGreaterThan(0);
    // The colleague does manicures only, so the sitting is the master's alone.
    expect(new Set(slots.map((slot) => slot.specialist_id))).toEqual(new Set([studio.specialistId]));
    expect(slots[0].duration_minutes).toBe(CANONICAL.serviceDurationMinutes + 15 + 60);

    const held = await hold(sitting(), slots[0]);
    expect(held.status).toBe(201);
    const created = await book(dataOf<{ hold_token: string }>(held).hold_token, sitting(), "+373 69 111 001");
    expect(created.status).toBe(201);
    const { id } = dataOf<{ id: string; status: string }>(created);

    const [row] = await adminDb.select().from(bookings).where(eq(bookings.id, id));
    expect((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000).toBe(165);
    expect(row.status).toBe("confirmed");
    const lines = await adminDb.select().from(bookingLines).where(eq(bookingLines.bookingId, id));
    expect(lines.filter((line) => line.kind === "service").map((line) => line.serviceId).sort()).toEqual(
      [studio.serviceId, pedicureId].sort(),
    );
    expect(lines.find((line) => line.kind === "add_on")).toMatchObject({ addOnId: designId, serviceId: studio.serviceId });
    expect(lines.reduce((sum, line) => sum + line.priceMinor, 0)).toBe(60_000 + 10_000 + 40_000);
  });

  test("refuses a booking whose services do not fill what was held", async () => {
    const slots = await slotsFor(sitting());
    const held = dataOf<{ hold_token: string }>(await hold(sitting(), slots[0])).hold_token;

    const shorter = await book(held, [{ service_id: studio.serviceId, add_on_ids: [] }], "+373 69 111 002");
    expect(shorter.status).toBe(409);
    expect(errorCodeOf(shorter)).toBe("HOLD_MISMATCH");
  });

  test("does not hold a sitting with a master who cannot do all of it", async () => {
    const slots = await slotsFor([{ service_id: studio.serviceId, add_on_ids: [] }], colleagueId);
    expect(slots.length).toBeGreaterThan(0);

    const refused = await hold(sitting(), slots[0]);
    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe("SLOT_UNAVAILABLE");
  });

  test("takes at most three services, never one twice, and an add-on only with its own service", async () => {
    const slots = await slotsFor(sitting());
    const four = [
      ...sitting(),
      { service_id: browsId, add_on_ids: [] },
      { service_id: lashesId, add_on_ids: [] },
    ];
    for (const items of [four, [...sitting(), { service_id: pedicureId, add_on_ids: [] }]]) {
      const refused = await hold(items, slots[0]);
      expect(refused.status).toBe(422);
      expect(errorCodeOf(refused)).toBe("VALIDATION_ERROR");
    }

    // The design is offered with the manicure, not with the pedicure.
    const misplaced = await hold(
      [
        { service_id: studio.serviceId, add_on_ids: [] },
        { service_id: pedicureId, add_on_ids: [designId] },
      ],
      slots[0],
    );
    expect(misplaced.status).toBe(409);
  });

  test("three services fit in one hold, and the client's link lists them", async () => {
    const three = [...sitting(), { service_id: browsId, add_on_ids: [] }];
    const slots = await slotsFor(three);
    expect(slots[0].duration_minutes).toBe(195);

    const held = dataOf<{ hold_token: string }>(await hold(three, slots[0])).hold_token;
    const created = dataOf<{ manage_token: string }>(await book(held, three, "+373 69 111 003"));
    const manage = dataOf<{ services: Item[]; price_minor: number }>(
      await anonymous.get(`/api/v1/public/bookings/${created.manage_token}`),
    );
    expect(manage.services.map((item) => item.service_id)).toEqual(three.map((item) => item.service_id));
    expect(manage.price_minor).toBe(60_000 + 10_000 + 40_000 + 20_000);
  });

  test("still books one service the way every page so far has", async () => {
    const one = [{ service_id: pedicureId, add_on_ids: [] }];
    const slots = await slotsFor(one);
    const held = dataOf<{ hold_token: string }>(
      await anonymous.post(path("holds"), {
        location_id: locationId,
        service_id: pedicureId,
        add_on_ids: [],
        specialist_id: slots[0].specialist_id,
        starts_at: slots[0].starts_at,
      }),
    ).hold_token;
    const created = await anonymous.post(
      path("bookings"),
      {
        hold_token: held,
        service_id: pedicureId,
        add_on_ids: [],
        name: "Анна",
        phone: "+373 69 111 004",
        email: null,
        contact_channels: [],
        locale: "ru",
        legal_accepted: true,
      },
      { "idempotency-key": `create-${crypto.randomUUID()}` },
    );
    expect(created.status).toBe(201);
  });
});
