import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookings } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadUnclosedBookings } from "@/lib/unclosed-bookings";

import { dataOf, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Appointments that happened and were never closed into a visit.
 *
 * What counts is narrow on purpose: confirmed, and over. Not a request still
 * waiting (the cron lapses those), not one in progress, not one already closed,
 * marked a no-show or cancelled — each of those already has its answer.
 */
describe("unclosed appointments", () => {
  let studio: Studio;
  let master: Actor;
  let colleagueId: string;
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

  /** Moves an appointment so that it started `hoursAgo` hours ago. */
  async function shiftTo(bookingId: string, hoursAgo: number) {
    const [row] = await adminDb
      .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    const shift = row.startsAt.getTime() - (Date.now() - hoursAgo * 60 * 60_000);
    await adminDb
      .update(bookings)
      .set({
        startsAt: new Date(row.startsAt.getTime() - shift),
        endsAt: new Date(row.endsAt.getTime() - shift),
      })
      .where(eq(bookings.id, bookingId));
  }

  async function book(specialistId = studio.specialistId) {
    return dataOf<{ id: string; version: number }>(
      await studio.owner.post(
        "/api/v1/bookings",
        { location_id: locationId, specialist_id: specialistId, service_id: studio.serviceId, starts_at: nextSlot() },
        { "idempotency-key": crypto.randomUUID() },
      ),
    );
  }

  async function unclosedFor(userId: string, role: "owner" | "master") {
    return withTenant(studio.organizationId, (tx) =>
      loadUnclosedBookings(tx, { userId, role }, { now: new Date(), locale: "ru", limit: 10 }),
    );
  }

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("unclosed-owner@studio.example", "Unclosed Studio");
    master = await inviteMember(studio.owner, "unclosed-master@studio.example", "master");
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

    colleagueId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Коллега",
        default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
      }),
    ).id;

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "unclosed-centru" }),
    ).id;
    for (const id of [studio.specialistId, colleagueId]) {
      await studio.owner.put(`/api/v1/specialists/${id}/locations`, { location_ids: [locationId] });
      await studio.owner.put("/api/v1/availability/rules", {
        specialist_id: id,
        location_id: locationId,
        intervals: [{ weekday: 3, start: "05:00", end: "21:00" }],
        effective_from: new Date().toISOString().slice(0, 10),
      });
    }
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("only confirmed appointments that are over are listed, with their «Итого»", async () => {
    // 90-minute appointments, spaced so none overlaps another of the same master.
    const over = await book();
    await shiftTo(over.id, 2);

    // Started half an hour ago and runs 90 minutes: being worked, not forgotten.
    const inProgress = await book();
    await shiftTo(inProgress.id, 0.5);

    // Still ahead.
    await book();

    const closed = await book();
    await shiftTo(closed.id, 4);
    await studio.owner.post(`/api/v1/bookings/${closed.id}/complete`, { version: closed.version });

    const missed = await book();
    await shiftTo(missed.id, 6);
    await studio.owner.post(`/api/v1/bookings/${missed.id}/no-show`, { version: missed.version });

    const result = await unclosedFor(studio.owner.userId, "owner");
    expect(result.items.map((item) => item.id)).toEqual([over.id]);
    expect(result.count).toBe(1);
    expect(result.totalMinor).toBe(CANONICAL.servicePriceMinor);
    expect(result.items[0].priceMinor).toBe(CANONICAL.servicePriceMinor);
  });

  test("a master sees only their own, the owner sees everybody's", async () => {
    const colleagues = await book(colleagueId);
    await shiftTo(colleagues.id, 6);

    const owner = await unclosedFor(studio.owner.userId, "owner");
    expect(owner.items.map((item) => item.id)).toContain(colleagues.id);

    const own = await unclosedFor(master.userId, "master");
    expect(own.items.map((item) => item.id)).not.toContain(colleagues.id);
    expect(own.items.every((item) => item.specialistId === studio.specialistId)).toBe(true);
  });

  test("the bell carries the count, scoped like the list", async () => {
    const ownerCount = dataOf<{ unclosed: number }>(
      await studio.owner.get("/api/v1/notifications?locale=ru"),
    ).unclosed;
    const masterCount = dataOf<{ unclosed: number }>(await master.get("/api/v1/notifications?locale=ru")).unclosed;

    expect(ownerCount).toBe((await unclosedFor(studio.owner.userId, "owner")).count);
    expect(masterCount).toBe((await unclosedFor(master.userId, "master")).count);
    expect(masterCount).toBeLessThan(ownerCount);
  });

  test("a report period narrows to appointments that ended inside it", async () => {
    const now = new Date();
    const within = (endedFrom: Date, endedTo: Date) =>
      withTenant(studio.organizationId, (tx) =>
        loadUnclosedBookings(
          tx,
          { userId: studio.owner.userId, role: "owner" },
          { now, locale: "ru", endedFrom, endedTo },
        ),
      );
    const all = await unclosedFor(studio.owner.userId, "owner");

    // Everything above ended within the last day.
    const lastDay = await within(new Date(now.getTime() - 24 * 3_600_000), now);
    expect(lastDay.count).toBe(all.count);
    expect(lastDay.totalMinor).toBe(all.totalMinor);

    // A period that closed before any of them ended holds none.
    const before = await within(new Date(0), new Date(now.getTime() - 24 * 3_600_000));
    expect(before.count).toBe(0);
  });
});
