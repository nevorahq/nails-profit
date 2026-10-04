import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, bookings, financialSnapshots, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadPeriodPL, monthOf } from "@/lib/period";

import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * What the client left on top, on both roads a visit is closed by and after.
 *
 * Canonical studio: a 600 MDL service, 40% to the master. A 50 MDL tip must
 * leave the revenue, the commission and the margin exactly where they were —
 * except for the terminal's percentage on it when the visit went by card.
 */
describe("tips", () => {
  let studio: Studio;
  let master: Actor;
  let locationId: string;
  let cardId: string;
  let colleagueId: string;
  let slot = 0;

  const TIP = 5_000;
  // 2% and 3 MDL a transaction.
  const CARD = { basisPoints: 200, fixedFeeMinor: 300 };

  function nextSlot() {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    day.setUTCHours(6 + 2 * slot);
    slot += 1;
    return day.toISOString();
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

  async function visitOf(visitId: string) {
    const [visit] = await withTenant(studio.organizationId, (tx) =>
      tx.select().from(visits).where(eq(visits.id, visitId)),
    );
    return visit;
  }

  async function closeManually(body: Record<string, unknown>) {
    return studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: studio.specialistId,
      actual_duration_minutes: CANONICAL.serviceDurationMinutes,
      ...body,
    });
  }

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("tips-owner@studio.example", "Tips Studio");
    master = await inviteMember(studio.owner, "tips-master@studio.example", "master");
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });
    colleagueId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Коллега",
        default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
      }),
    ).id;

    cardId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/payment-methods", {
        name: "Карта",
        kind: "card",
        commission_basis_points: CARD.basisPoints,
        fixed_fee_minor: CARD.fixedFeeMinor,
      }),
    ).id;

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "tips-centru" }),
    ).id;
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "05:00", end: "21:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("a tip in cash leaves every figure of the visit where it was", async () => {
    const visitId = dataOf<{ id: string }>(await closeManually({ tip_minor: TIP, payment_method_id: null })).id;

    expect((await visitOf(visitId)).tipMinor).toBe(TIP);
    const snapshot = await snapshotOf(visitId);
    expect(snapshot.revenueMinor).toBe(CANONICAL.servicePriceMinor);
    expect(snapshot.commissionMinor).toBe(CANONICAL.commissionMinor);
    expect(snapshot.contributionMarginMinor).toBe(CANONICAL.contributionMarginMinor);
    expect(snapshot.paymentCommissionMinor).toBe(0);
  });

  test("a tip by card costs the studio the terminal's percentage on it, once", async () => {
    const visitId = dataOf<{ id: string }>(await closeManually({ tip_minor: TIP, payment_method_id: cardId })).id;

    const snapshot = await snapshotOf(visitId);
    // 2% of 650 and one 3 MDL fee.
    expect(snapshot.paymentCommissionMinor).toBe(1_300 + 300);
    expect(snapshot.revenueMinor).toBe(CANONICAL.servicePriceMinor);
    expect(snapshot.commissionMinor).toBe(CANONICAL.commissionMinor);
    expect(snapshot.contributionMarginMinor).toBe(CANONICAL.contributionMarginMinor - 1_600);
  });

  test("closing a booking with a tip costs what entering the visit by hand does", async () => {
    const created = dataOf<{ id: string; version: number }>(
      await studio.owner.post(
        "/api/v1/bookings",
        { location_id: locationId, specialist_id: studio.specialistId, service_id: studio.serviceId, starts_at: nextSlot() },
        { "idempotency-key": crypto.randomUUID() },
      ),
    );
    const [row] = await adminDb.select().from(bookings).where(eq(bookings.id, created.id));
    const shift = row.startsAt.getTime() - (Date.now() - 3 * 60 * 60_000);
    await adminDb
      .update(bookings)
      .set({ startsAt: new Date(row.startsAt.getTime() - shift), endsAt: new Date(row.endsAt.getTime() - shift) })
      .where(eq(bookings.id, created.id));

    const closed = await studio.owner.post(
      `/api/v1/bookings/${created.id}/complete`,
      {
        version: created.version,
        actual_duration_minutes: CANONICAL.serviceDurationMinutes,
        paid_minor: 55_000,
        tip_minor: TIP,
      },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(closed.status).toBe(201);
    const fromBooking = dataOf<{ visit: { id: string } }>(closed).visit.id;
    // The booking took the studio's default method, which is none here: cash.
    const byHand = dataOf<{ id: string }>(await closeManually({ paid_minor: 55_000, tip_minor: TIP })).id;

    expect((await visitOf(fromBooking)).tipMinor).toBe(TIP);
    const [a, b] = [await snapshotOf(fromBooking), await snapshotOf(byHand)];
    for (const field of ["revenueMinor", "commissionMinor", "paymentCommissionMinor", "contributionMarginMinor"] as const) {
      expect(a[field]).toBe(b[field]);
    }
    expect(a.revenueMinor).toBe(55_000);
  });

  test("a tip left afterwards is a correction: a new snapshot and an audited change", async () => {
    const visitId = dataOf<{ id: string }>(await closeManually({ payment_method_id: cardId })).id;
    expect((await snapshotOf(visitId)).paymentCommissionMinor).toBe(1_200 + 300);

    const adjusted = await studio.owner.post(`/api/v1/visits/${visitId}/adjust`, {
      tip_minor: TIP,
      reason: "Чаевые переводом",
    });
    expect(adjusted.status).toBe(201);
    expect(dataOf<{ snapshot_version: number }>(adjusted).snapshot_version).toBe(2);

    expect((await visitOf(visitId)).tipMinor).toBe(TIP);
    expect((await snapshotOf(visitId)).paymentCommissionMinor).toBe(1_300 + 300);

    const [event] = await withTenant(studio.organizationId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, visitId), eq(auditEvents.eventType, "visit.adjusted"))),
    );
    expect(event.before).toMatchObject({ tip_minor: 0 });
    expect(event.after).toMatchObject({ tip_minor: TIP });

    // And taken back to nothing, the fee goes back with it.
    await studio.owner.post(`/api/v1/visits/${visitId}/adjust`, { tip_minor: 0 });
    expect((await snapshotOf(visitId)).paymentCommissionMinor).toBe(1_200 + 300);
  });

  test("refuses a negative or fractional tip on every road", async () => {
    for (const tip of [-1, 1.5]) {
      const manual = await closeManually({ tip_minor: tip });
      expect(manual.status).toBe(422);
      expect(errorCodeOf(manual)).toBe("VALIDATION_ERROR");
    }
    const visitId = dataOf<{ id: string }>(await closeManually({})).id;
    const adjust = await studio.owner.post(`/api/v1/visits/${visitId}/adjust`, { tip_minor: -1 });
    expect(adjust.status).toBe(422);
  });

  test("a master sees the tips on their own visits and not on a colleague's", async () => {
    const own = dataOf<{ id: string }>(await closeManually({ tip_minor: 7_700 })).id;
    const theirs = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: colleagueId,
        tip_minor: 9_900,
      }),
    ).id;

    const listed = dataOf<{ id: string; tip_minor: number }[]>(await master.get("/api/v1/visits"));
    expect(listed.find((visit) => visit.id === own)?.tip_minor).toBe(7_700);
    expect(listed.some((visit) => visit.id === theirs)).toBe(false);

    // Nor may they set one on it.
    const refused = await master.post(`/api/v1/visits/${theirs}/adjust`, { tip_minor: 1 });
    expect(refused.status).toBe(403);
  });

  test("the month counts tips in the cash flow and in the master's line, never in the revenue", async () => {
    const report = await withTenant(studio.organizationId, (tx) =>
      loadPeriodPL(tx, { month: monthOf(new Date()), currency: "MDL", organizationId: studio.organizationId }, "ru"),
    );
    const tipsOnVisits = await withTenant(studio.organizationId, (tx) => tx.select().from(visits));
    const tips = tipsOnVisits.reduce((sum, visit) => sum + visit.tipMinor, 0);
    expect(tips).toBeGreaterThan(0);

    // Every visit here was 600 at the price list but two paid 550 — and the
    // revenue is that, without a unit of the tips.
    expect(report.pl.revenueMinor).toBe(tipsOnVisits.length * CANONICAL.servicePriceMinor - 2 * 5_000);

    // In, and handed back out: neither master is a principal.
    expect(report.cashFlow.tipsMinor).toBe(tips);
    expect(report.cashFlow.tipsPaidOutMinor).toBe(tips);

    const ownTips = tipsOnVisits
      .filter((visit) => visit.specialistId === studio.specialistId)
      .reduce((sum, visit) => sum + visit.tipMinor, 0);
    const line = report.masterBreakdown.find((entry) => entry.specialistId === studio.specialistId)!;
    expect(line.tipsMinor).toBe(ownTips);
    expect(report.masterBreakdown.find((entry) => entry.specialistId === colleagueId)!.tipsMinor).toBe(9_900);
  });

  test("a principal's tips stay on the account", async () => {
    await studio.owner.patch(`/api/v1/specialists/${colleagueId}`, { is_principal: true });
    await studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: colleagueId,
      tip_minor: 1_100,
    });

    const report = await withTenant(studio.organizationId, (tx) =>
      loadPeriodPL(tx, { month: monthOf(new Date()), currency: "MDL", organizationId: studio.organizationId }, "ru"),
    );
    // Only the new 11: whether the master was a principal is copied when a visit
    // closes, so the 99 left while they were hired was handed on and stays so.
    expect(report.cashFlow.tipsMinor - report.cashFlow.tipsPaidOutMinor).toBe(1_100);
  });
});

