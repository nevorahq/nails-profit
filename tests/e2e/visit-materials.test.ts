import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookings, financialSnapshots, materialsCostingPeriods, visitLines } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { CURRENT_FORMULA_VERSION } from "@/domain/costing";

import { dataOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createAddOn } from "../helpers/factories";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * Materials, as a closed visit keeps them.
 *
 * A visit closed in a month counted per service copies what its service and
 * add-ons use up onto its lines and takes the sum off its margin — the same
 * whether it closed a booking or was entered by hand, since both go through
 * `recordCompletedVisit`. Editing the amount on the service afterwards, or
 * correcting the visit, does not touch what it was costed with. A month
 * counted by purchases copies nothing.
 */

const MATERIALS = 3_500;
const DESIGN_MATERIALS = 1_000;

let perService: Studio;
let byPurchases: Studio;
let designId: string;
let locationId: string;

async function snapshotOf(studio: Studio, visitId: string) {
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

function linesOf(studio: Studio, visitId: string) {
  return withTenant(studio.organizationId, (tx) =>
    tx.select().from(visitLines).where(eq(visitLines.visitId, visitId)),
  );
}

function closeByHand(studio: Studio, addOnIds: string[] = []) {
  return studio.owner.post("/api/v1/visits", {
    specialist_id: studio.specialistId,
    service_id: studio.serviceId,
    add_on_ids: addOnIds,
  });
}

beforeAll(async () => {
  await resetDatabase();
  perService = await createCanonicalStudio("materials-visit@studio.example", "Per Service Studio");
  byPurchases = await createCanonicalStudio("materials-purchases@studio.example", "Purchases Studio");

  // Long counted per service, so today's month is whatever the clock says.
  await adminDb.insert(materialsCostingPeriods).values({
    organizationId: perService.organizationId,
    mode: "per_service",
    effectiveFrom: "2020-01-01",
  });
  for (const studio of [perService, byPurchases]) {
    await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, { materials_minor: MATERIALS });
  }
  designId = (await createAddOn(perService.organizationId, { name: "Дизайн", priceDeltaMinor: 10_000 })).id;
  await perService.owner.patch(`/api/v1/add-ons/${designId}`, { materials_minor: DESIGN_MATERIALS });

  locationId = dataOf<{ id: string }>(
    await perService.owner.post("/api/v1/locations", {
      name: "Центр",
      slug: "materials-centru",
      timezone: "Europe/Chisinau",
    }),
  ).id;
  await perService.owner.put(`/api/v1/specialists/${perService.specialistId}/locations`, {
    location_ids: [locationId],
  });
  await perService.owner.put("/api/v1/availability/rules", {
    specialist_id: perService.specialistId,
    location_id: locationId,
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "00:00", end: "23:59" })),
    effective_from: new Date().toISOString().slice(0, 10),
  });
  await perService.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
    confirmation_mode: "instant",
    min_lead_minutes: 0,
    max_advance_days: 90,
  });
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("a visit closed in a month counted per service", () => {
  test("keeps its service's and add-on's materials on its lines and takes them off its margin", async () => {
    const closed = dataOf<{ id: string }>(await closeByHand(perService, [designId]));
    const lines = await linesOf(perService, closed.id);
    expect(Object.fromEntries(lines.map((line) => [line.kind, line.materialsMinor]))).toEqual({
      service: MATERIALS,
      add_on: DESIGN_MATERIALS,
    });

    const snapshot = await snapshotOf(perService, closed.id);
    expect(snapshot.formulaVersion).toBe(CURRENT_FORMULA_VERSION);
    expect(snapshot.materialsMinor).toBe(MATERIALS + DESIGN_MATERIALS);
    // 70 000 − 40% − 4 500.
    expect(snapshot.contributionMarginMinor).toBe(37_500);
  });

  test("does not change when the amount on the service is edited, or when the visit is corrected", async () => {
    const closed = dataOf<{ id: string }>(await closeByHand(perService));
    const before = await snapshotOf(perService, closed.id);
    expect(before.materialsMinor).toBe(MATERIALS);

    await perService.owner.patch(`/api/v1/services/${perService.serviceId}`, { materials_minor: 9_999 });
    try {
      expect(await snapshotOf(perService, closed.id)).toEqual(before);

      // A correction writes a new version — from the lines, not the catalogue.
      const adjusted = await perService.owner.post(`/api/v1/visits/${closed.id}/adjust`, {
        actual_duration_minutes: 95,
      });
      expect(adjusted.status).toBe(201);
      const after = await snapshotOf(perService, closed.id);
      expect(after.snapshotVersion).toBe(before.snapshotVersion + 1);
      expect(after.materialsMinor).toBe(MATERIALS);
      expect(after.contributionMarginMinor).toBe(before.contributionMarginMinor);
    } finally {
      await perService.owner.patch(`/api/v1/services/${perService.serviceId}`, { materials_minor: MATERIALS });
    }
  });

  test("costs a booking closed into a visit exactly as the visit entered by hand", async () => {
    const startsAt = new Date(Date.now() + 2 * 60 * 60_000);
    startsAt.setUTCMinutes(0, 0, 0);
    const booking = dataOf<{ id: string; version: number }>(
      await perService.owner.post(
        "/api/v1/bookings",
        {
          location_id: locationId,
          specialist_id: perService.specialistId,
          starts_at: startsAt.toISOString(),
          service_id: perService.serviceId,
          add_on_ids: [],
        },
        { "idempotency-key": crypto.randomUUID() },
      ),
    );
    // Moved into the past behind the product's back: a visit cannot be closed
    // before its appointment began, and this test cannot wait.
    const [row] = await adminDb.select().from(bookings).where(eq(bookings.id, booking.id));
    const shift = row.startsAt.getTime() - (Date.now() - 3 * 60 * 60_000);
    await adminDb
      .update(bookings)
      .set({ startsAt: new Date(row.startsAt.getTime() - shift), endsAt: new Date(row.endsAt.getTime() - shift) })
      .where(eq(bookings.id, booking.id));

    const closed = await perService.owner.post(
      `/api/v1/bookings/${booking.id}/complete`,
      { version: booking.version },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(closed.status).toBe(201);
    const fromBooking = await snapshotOf(perService, dataOf<{ visit: { id: string } }>(closed).visit.id);
    const byHand = await snapshotOf(perService, dataOf<{ id: string }>(await closeByHand(perService)).id);

    expect(fromBooking.materialsMinor).toBe(MATERIALS);
    expect(fromBooking.materialsMinor).toBe(byHand.materialsMinor);
    expect(fromBooking.contributionMarginMinor).toBe(byHand.contributionMarginMinor);
  });
});

describe("a visit closed in a month counted by purchases", () => {
  test("copies no materials and costs as before, whatever the service holds", async () => {
    const closed = dataOf<{ id: string }>(await closeByHand(byPurchases));
    const [line] = await linesOf(byPurchases, closed.id);
    expect(line.materialsMinor).toBeNull();

    const snapshot = await snapshotOf(byPurchases, closed.id);
    expect(snapshot.materialsMinor).toBe(0);
    expect(snapshot.contributionMarginMinor).toBe(CANONICAL.contributionMarginMinor);
  });
});
