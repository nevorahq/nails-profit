import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { financialSnapshots, notificationOutbox, visits } from "@/db/schema";
import { setNotificationProvider, type OutgoingMessage } from "@/lib/notification-provider";
import { anonymous, dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * What the client is told when the studio acts, roadmap section 7.7, and the
 * job that actually sends it.
 *
 * The half of 7.4 that is easiest to leave out: every message here is triggered
 * by a member of staff pressing a button, so nothing in the public flow fails
 * when they are missing — the client simply never hears anything.
 */
describe("transactional notifications", () => {
  let studio: Studio;
  let owner: Actor;
  let locationId: string;
  let clientId: string;
  let issued = 0;
  const previousToken = process.env.OPS_API_TOKEN;
  const opsToken = "test-operator-token-that-is-long-enough";

  const firstWednesday = (() => {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    return day;
  })();

  function nextSlot() {
    const index = issued++;
    const start = new Date(firstWednesday);
    start.setUTCDate(start.getUTCDate() + 7 * Math.floor(index / 6));
    start.setUTCHours(6 + 2 * (index % 6));
    return start.toISOString();
  }

  async function book() {
    return dataOf<{ id: string; version: number }>(
      await owner.post(
        "/api/v1/bookings",
        {
          location_id: locationId,
          specialist_id: studio.specialistId,
          service_id: studio.serviceId,
          client_id: clientId,
          starts_at: nextSlot(),
        },
        { "idempotency-key": `notify-${crypto.randomUUID()}` },
      ),
    );
  }

  async function templatesFor(bookingId: string) {
    const rows = await adminDb
      .select({ template: notificationOutbox.template, status: notificationOutbox.status })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, bookingId));
    return rows.map((row) => row.template).sort();
  }

  beforeAll(async () => {
    await resetDatabase();
    process.env.OPS_API_TOKEN = opsToken;
    studio = await createCanonicalStudio("notify-owner@studio.example", "Notify Studio");
    owner = studio.owner;

    locationId = dataOf<{ id: string }>(
      await owner.post("/api/v1/locations", { name: "Центр", slug: "notify-centru" }),
    ).id;
    await owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "07:00", end: "21:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });

    clientId = dataOf<{ id: string }>(
      await owner.post("/api/v1/clients", { name: "Мария", phone: "+373 69 777 888" }),
    ).id;
  });

  afterAll(async () => {
    if (previousToken === undefined) delete process.env.OPS_API_TOKEN;
    else process.env.OPS_API_TOKEN = previousToken;
    setNotificationProvider(null);
    await closeTestConnections();
  });

  test("a booking taken at the desk is confirmed to the client and reminded about", async () => {
    const created = await book();
    expect(await templatesFor(created.id)).toEqual(["booking.confirmed", "booking.reminder"]);
  });

  test("a studio cancellation reaches the client and drops the reminder", async () => {
    const created = await book();
    await owner.post(`/api/v1/bookings/${created.id}/cancel`, {
      reason: "studio_request",
      cancelled_by: "staff",
    });

    // The confirmation stays — it was true when it was queued — the reminder
    // does not, and the cancellation is added.
    expect(await templatesFor(created.id)).toEqual(["booking.cancelled", "booking.confirmed"]);
  });

  test("a studio reschedule tells the client the new time", async () => {
    const created = await book();
    const moved = await owner.post(`/api/v1/bookings/${created.id}/reschedule`, {
      starts_at: nextSlot(),
      version: created.version,
    });
    expect(moved.status).toBe(200);

    expect(await templatesFor(created.id)).toEqual([
      "booking.confirmed",
      "booking.reminder",
      "booking.rescheduled",
    ]);
  });

  test("a no-show leaves nothing queued for the client", async () => {
    const created = await book();
    await owner.post(`/api/v1/bookings/${created.id}/no-show`, {});
    expect(await templatesFor(created.id)).toEqual(["booking.confirmed"]);
  });

  test("a completed appointment stops being reminded about, and is thanked for", async () => {
    const created = await book();
    const completed = await owner.post(`/api/v1/bookings/${created.id}/complete`, {
      version: created.version,
    });
    expect(completed.status).toBe(201);

    /*
     * The reminder is gone — there is nothing left to remind anyone of — and
     * the follow-up takes its place.
     *
     * That second message used to be absent here, and for a reason that has
     * stopped being true: `notifyVisitCompleted` sends it only to a studio with
     * a public booking page, because it invites the client back to one, and a
     * studio created through the API had no address until somebody typed one.
     * Every studio is given an address when it is created now, so the ordinary
     * case is a studio that has one.
     */
    expect(await templatesFor(created.id)).toEqual([
      "booking.confirmed",
      "booking.visit_completed",
    ]);
  });

  test("a retried booking completion replays one visit and one snapshot", async () => {
    const created = await book();
    const payload = { version: created.version };
    const headers = { "idempotency-key": `complete-${created.id}` };

    const first = await owner.post(`/api/v1/bookings/${created.id}/complete`, payload, headers);
    const replay = await owner.post(`/api/v1/bookings/${created.id}/complete`, payload, headers);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const storedVisits = await adminDb
      .select({ id: visits.id })
      .from(visits)
      .where(eq(visits.bookingId, created.id));
    expect(storedVisits).toHaveLength(1);
    const snapshots = await adminDb
      .select({ id: financialSnapshots.id })
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, storedVisits[0].id));
    expect(snapshots).toHaveLength(1);
  });

  test("staff can reissue a lost manage link without ever seeing it", async () => {
    const created = await book();
    const reissued = await owner.post(`/api/v1/bookings/${created.id}/manage-link`, {});

    expect(reissued.status).toBe(200);
    expect(dataOf<{ sent_to: string[] }>(reissued).sent_to).toEqual(["sms"]);
    // The response carries no token: the link travels to the contact on the
    // booking, not through the screen of whoever pressed the button.
    expect(JSON.stringify(reissued.body)).not.toContain(studio.organizationId);
    expect(await templatesFor(created.id)).toContain("booking.link_reissued");
  });

  describe("the dispatch job", () => {
    test("refuses a caller without the operator token", async () => {
      const refused = await anonymous.post("/api/v1/ops/notifications", {
        organization_id: studio.organizationId,
      });
      expect(refused.status).toBe(401);
      expect(errorCodeOf(refused)).toBe("UNAUTHENTICATED");
    });

    test("drains one tenant's queue and marks what it sent", async () => {
      const sent: OutgoingMessage[] = [];
      setNotificationProvider({
        name: "fake",
        async send(message) {
          sent.push(message);
          return { ok: true, providerMessageId: `fake:${sent.length}` };
        },
      });

      const created = await book();
      const summary = dataOf<{ claimed: number; sent: number; dead_lettered: number }>(
        await anonymous.post(
          "/api/v1/ops/notifications",
          { organization_id: studio.organizationId },
          { authorization: `Bearer ${opsToken}` },
        ),
      );

      expect(summary.sent).toBeGreaterThan(0);
      expect(summary.dead_lettered).toBe(0);
      // The reminder is due the day before the appointment, so it stays behind.
      const [reminder] = await adminDb
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.bookingId, created.id),
            eq(notificationOutbox.template, "booking.reminder"),
          ),
        );
      expect(reminder.status).toBe("pending");

      const [confirmation] = await adminDb
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.bookingId, created.id),
            eq(notificationOutbox.template, "booking.confirmed"),
          ),
        );
      expect(confirmation.status).toBe("sent");
      expect(confirmation.providerMessageId).toMatch(/^fake:/);
      // Every message a client receives can act on the booking it is about.
      expect(sent.some((message) => message.body.includes("/booking/"))).toBe(true);
      setNotificationProvider(null);
    });
  });
});
