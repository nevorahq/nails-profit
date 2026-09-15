import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { anonymous, dataOf, errorCodeOf } from "../helpers/api";
import { wednesdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The order a studio puts its masters in.
 *
 * `specialist.sort_order` was read from the day it was added — the order of
 * names on the public page, the order of the list in «Онлайн-запись», and the
 * tie-break that decides which master «Любой доступный» hands a shared hour to
 * (`lib/public-booking-availability.ts`). Nothing could write it. Every card
 * kept the default `0`, the tie fell through to comparing UUIDs, and one
 * master took every hour of an empty day for a reason no studio could see or
 * change.
 *
 * So the tests that matter are not that a number round-trips. They are that
 * the studio's answer reaches the client: the list comes back in the order it
 * was given, and the hour goes to the master the studio put first.
 */
type Slot = { starts_at: string; specialist_id: string; specialist_name: string };
type Card = { id: string; name: string; sort_order: number };

describe("the order a studio puts its masters in", () => {
  let studio: Studio;
  let locationId: string;
  /** The second pair of hands. `studio.specialistId` is the first. */
  let secondId: string;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("order-owner@studio.example", "Order Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "order-studio" });
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));

    secondId = dataOf<Card>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Вторая",
        default_rule: { type: "percentage", basis_points: 4000 },
      }),
    ).id;

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "centru",
        address: "str. Ismail 33",
        timezone: "Europe/Chisinau",
      }),
    ).id;

    /*
     * Both masters at the same address, on the same day, for the same service
     * at the same length — so their offered hours land on identical start
     * times and nothing but the order can separate them. Neither is given a
     * service assignment: an empty list means "does everything", which is what
     * makes the two of them equal candidates for the same slot.
     */
    for (const specialistId of [studio.specialistId, secondId]) {
      await studio.owner.put(`/api/v1/specialists/${specialistId}/locations`, {
        location_ids: [locationId],
      });
      await studio.owner.put("/api/v1/availability/rules", {
        specialist_id: specialistId,
        location_id: locationId,
        effective_from: "2026-08-01",
        intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
      });
    }

    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
      max_advance_days: 90,
    });
  }, 60_000);

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    await closeTestConnections();
  });

  /** Who «Любой доступный» offers the day's hours to. */
  async function whoGetsTheDay(nth: number): Promise<string[]> {
    const availability = dataOf<{ slots: Slot[] }>(
      await anonymous.get(
        `/api/v1/public/booking/order-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${wednesdayAhead(nth)}`,
      ),
    );
    expect(availability.slots.length).toBeGreaterThan(0);
    return [...new Set(availability.slots.map((slot) => slot.specialist_id))];
  }

  test("a card is created at the front of the list unless the studio says otherwise", async () => {
    // The default has to stay `0`: a studio that has never thought about the
    // order should get the order it hired in, which is what the second sort
    // key gives once every card shares the first one.
    const cards = dataOf<Card[]>(await studio.owner.get("/api/v1/specialists"));
    expect(cards.map((card) => card.sort_order)).toEqual([0, 0]);
    expect(cards.map((card) => card.id)).toEqual([studio.specialistId, secondId]);

    // Given an order, the card lands where it was put rather than where it was
    // created. She stays for the rest of the suite as a name in the list and
    // nothing more.
    const third = dataOf<Card>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Третья",
        sort_order: 7,
        default_rule: { type: "percentage", basis_points: 3000 },
      }),
    );
    expect(third.sort_order).toBe(7);

    /*
     * And taken off the addresses, which is now something to say rather than
     * something to leave out: a card is created at every active address with
     * the studio's own week already on it, so a master nobody has decided
     * anything about is bookable. The tests below need a third name no client
     * is offered, and «Онлайн-запись» — this call — is how a studio arranges
     * that.
     */
    expect(
      (await studio.owner.put(`/api/v1/specialists/${third.id}/locations`, { location_ids: [] }))
        .status,
    ).toBe(200);

    const withThird = dataOf<Card[]>(await studio.owner.get("/api/v1/specialists"));
    expect(withThird.map((card) => card.name)).toEqual(["Мастер", "Вторая", "Третья"]);
  });

  test("moving a card reorders the list it is read from", async () => {
    const moved = dataOf<Card>(
      await studio.owner.patch(`/api/v1/specialists/${secondId}`, { sort_order: 0 }),
    );
    expect(moved.sort_order).toBe(0);

    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { sort_order: 1 });

    const cards = dataOf<Card[]>(await studio.owner.get("/api/v1/specialists"));
    expect(cards.map((card) => card.name)).toEqual(["Вторая", "Мастер", "Третья"]);
  });

  test("an order outside the range is refused rather than quietly clamped", async () => {
    expect(
      errorCodeOf(await studio.owner.patch(`/api/v1/specialists/${secondId}`, { sort_order: -1 })),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCodeOf(await studio.owner.patch(`/api/v1/specialists/${secondId}`, { sort_order: 1_001 })),
    ).toBe("VALIDATION_ERROR");

    // The refusal left the card where it was, rather than half-applying.
    const cards = dataOf<Card[]>(await studio.owner.get("/api/v1/specialists"));
    expect(cards.find((card) => card.id === secondId)?.sort_order).toBe(0);
  });

  test("«любой доступный» hands the empty day to whoever the studio put first", async () => {
    // Nobody is booked, so both masters carry zero minutes and the order is
    // the only thing left to decide by. This is the case that used to be
    // settled by whichever UUID sorted lower.
    expect(await whoGetsTheDay(1)).toEqual([secondId]);

    await studio.owner.patch(`/api/v1/specialists/${secondId}`, { sort_order: 1 });
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { sort_order: 0 });

    expect(await whoGetsTheDay(2)).toEqual([studio.specialistId]);
  });
});
