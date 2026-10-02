import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookings, financialSnapshots, visitLines } from "@/db/schema";
import { withTenant } from "@/db/tenant";

import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createAddOn } from "../helpers/factories";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * Recording what the client actually paid, on both roads a visit is closed by.
 *
 * Canonical studio: a 600 MDL service, 40% to the master after discount. The
 * figures below are that arithmetic with the amount paid substituted for the
 * price list — which is the whole of the feature.
 */
describe("what the client paid", () => {
  let studio: Studio;
  let manual: Studio;
  let locationId: string;
  let slot = 0;

  function nextSlot() {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    day.setUTCDate(day.getUTCDate() + 7 * Math.floor(slot / 6));
    day.setUTCHours(6 + 2 * (slot % 6));
    slot += 1;
    return day.toISOString();
  }

  /** Moves an appointment into the past, which is all a visit needs to be closable. */
  async function alreadyHappened(bookingId: string) {
    const [row] = await adminDb
      .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    const shift = row.startsAt.getTime() - (Date.now() - 2 * 60 * 60_000);
    await adminDb
      .update(bookings)
      .set({
        startsAt: new Date(row.startsAt.getTime() - shift),
        endsAt: new Date(row.endsAt.getTime() - shift),
      })
      .where(eq(bookings.id, bookingId));
  }

  async function book(): Promise<{ id: string; version: number; price_minor: number }> {
    const created = dataOf<{ id: string; version: number; price_minor: number }>(
      await studio.owner.post(
        "/api/v1/bookings",
        {
          location_id: locationId,
          specialist_id: studio.specialistId,
          service_id: studio.serviceId,
          starts_at: nextSlot(),
        },
        { "idempotency-key": crypto.randomUUID() },
      ),
    );
    await alreadyHappened(created.id);
    return created;
  }

  async function latestSnapshot(organizationId: string, visitId: string) {
    const [snapshot] = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(financialSnapshots)
        .where(eq(financialSnapshots.visitId, visitId))
        .orderBy(desc(financialSnapshots.snapshotVersion))
        .limit(1),
    );
    return snapshot;
  }

  async function linesOf(organizationId: string, visitId: string) {
    return withTenant(organizationId, (tx) =>
      tx.select().from(visitLines).where(eq(visitLines.visitId, visitId)),
    );
  }

  async function closeManually(target: Studio, body: Record<string, unknown> = {}) {
    return target.owner.post("/api/v1/visits", {
      service_id: target.serviceId,
      specialist_id: target.specialistId,
      actual_duration_minutes: CANONICAL.serviceDurationMinutes,
      ...body,
    });
  }

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("paid-owner@studio.example", "Paid Studio");
    manual = await createCanonicalStudio("paid-manual@studio.example", "Paid Manual Studio");

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "paid-centru" }),
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
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("paying less is a discount, and the master's percentage follows it", async () => {
    const response = await closeManually(manual, { paid_minor: 50_000 });
    expect(response.status).toBe(201);
    const visitId = dataOf<{ id: string }>(response).id;

    const snapshot = await latestSnapshot(manual.organizationId, visitId);
    expect(snapshot.revenueMinor).toBe(50_000);
    expect(snapshot.commissionMinor).toBe(20_000);
    expect(snapshot.contributionMarginMinor).toBe(30_000);

    const [line] = await linesOf(manual.organizationId, visitId);
    // The price list is kept; what changed is the discount on it.
    expect(line.priceMinor).toBe(CANONICAL.servicePriceMinor);
    expect(line.discountMinor).toBe(10_000);
  });

  test("paying more is a surcharge line the master is paid on like the service", async () => {
    const visitId = dataOf<{ id: string }>(await closeManually(manual, { paid_minor: 65_000 })).id;

    const lines = await linesOf(manual.organizationId, visitId);
    const surcharge = lines.find((line) => line.kind === "surcharge");
    expect(surcharge?.priceMinor).toBe(5_000);
    expect(surcharge?.commissionable).toBe(true);
    expect(surcharge?.nameSnapshot).toMatchObject({ ru: "Доплата", ro: "Supliment", en: "Extra charge" });

    const snapshot = await latestSnapshot(manual.organizationId, visitId);
    expect(snapshot.revenueMinor).toBe(65_000);
    expect(snapshot.commissionMinor).toBe(26_000);
  });

  test("leaving the field out records the price list, as before", async () => {
    const visitId = dataOf<{ id: string }>(await closeManually(manual)).id;
    const snapshot = await latestSnapshot(manual.organizationId, visitId);
    expect(snapshot.revenueMinor).toBe(CANONICAL.servicePriceMinor);
    expect(snapshot.contributionMarginMinor).toBe(CANONICAL.contributionMarginMinor);
  });

  test("a visit given away is recorded without a margin", async () => {
    const visitId = dataOf<{ id: string }>(await closeManually(manual, { paid_minor: 0 })).id;
    const snapshot = await latestSnapshot(manual.organizationId, visitId);
    expect(snapshot.revenueMinor).toBe(0);
    expect(snapshot.incompleteReasons).toEqual(["no_revenue"]);
  });

  test("a negative or fractional amount is refused", async () => {
    for (const paid of [-1, 1.5]) {
      const response = await closeManually(manual, { paid_minor: paid });
      expect(response.status).toBe(422);
      expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
    }
  });

  test("an add-on that makes the visit cheaper can be closed (it used to fail with a 500)", async () => {
    const shorter = await createAddOn(manual.organizationId, { priceDeltaMinor: -10_000 });
    const response = await closeManually(manual, { add_on_ids: [shorter.id] });
    expect(response.status).toBe(201);

    const snapshot = await latestSnapshot(manual.organizationId, dataOf<{ id: string }>(response).id);
    expect(snapshot.revenueMinor).toBe(50_000);
    expect(snapshot.commissionMinor).toBe(20_000);
  });

  test("closing a booking with an amount gives the same snapshot as the manual flow", async () => {
    const booking = await book();
    const closed = await studio.owner.post(`/api/v1/bookings/${booking.id}/complete`, {
      version: booking.version,
      actual_duration_minutes: CANONICAL.serviceDurationMinutes,
      paid_minor: 50_000,
    });
    expect(closed.status).toBe(201);
    const fromBooking = await latestSnapshot(
      studio.organizationId,
      dataOf<{ visit: { id: string } }>(closed).visit.id,
    );

    const fromHand = await latestSnapshot(
      manual.organizationId,
      dataOf<{ id: string }>(await closeManually(manual, { paid_minor: 50_000 })).id,
    );

    for (const field of [
      "revenueMinor",
      "commissionMinor",
      "contributionMarginMinor",
      "marginBasisPoints",
      "profitPerHourMinor",
    ] as const) {
      expect(fromBooking[field]).toBe(fromHand[field]);
    }
  });

  test("a booking closes at the price it quoted, even after the price list moved", async () => {
    const booking = await book();
    expect(booking.price_minor).toBe(CANONICAL.servicePriceMinor);

    await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, {
      price_minor: CANONICAL.servicePriceMinor + 10_000,
    });

    const closed = await studio.owner.post(`/api/v1/bookings/${booking.id}/complete`, {
      version: booking.version,
    });
    expect(closed.status).toBe(201);
    const snapshot = await latestSnapshot(
      studio.organizationId,
      dataOf<{ visit: { id: string } }>(closed).visit.id,
    );
    expect(snapshot.revenueMinor).toBe(CANONICAL.servicePriceMinor);

    await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, {
      price_minor: CANONICAL.servicePriceMinor,
    });
  });

  test("a full-price rule pays on the price list, whatever the client paid", async () => {
    await manual.owner.post(`/api/v1/specialists/${manual.specialistId}/commission-rules`, {
      type: "percentage",
      basis_points: CANONICAL.commissionBasisPoints,
      base: "full_price",
    });

    const visitId = dataOf<{ id: string }>(await closeManually(manual, { paid_minor: 50_000 })).id;
    const snapshot = await latestSnapshot(manual.organizationId, visitId);
    expect(snapshot.revenueMinor).toBe(50_000);
    // 40% of the 600 on the price list, not of the 500 taken.
    expect(snapshot.commissionMinor).toBe(24_000);
  });
});
