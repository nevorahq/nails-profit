import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { withTenant } from "@/db/tenant";
import { notifyBooking } from "@/lib/booking-notifications";
import { createBooking, holdSlot } from "@/lib/booking-service";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import {
  createClient,
  createLocation,
  createOrganization,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The Gate 7 report of section 7.10, run the way an operator runs it.
 *
 * The arithmetic is unit-tested in `scripts/booking-metrics-core.test.mjs`; what
 * this covers is the half that cannot be tested without PostgreSQL — six
 * hand-written queries, including the overlap check that is supposed to answer
 * "ни одна пара активных bookings не пересекается" from the data rather than
 * from the schema's promise.
 */
const run = promisify(execFile);

const LINES = [
  {
    kind: "service" as const,
    serviceId: null,
    addOnId: null,
    nameSnapshot: { ru: "Маникюр" },
    priceMinor: 60_000,
    durationMinutes: 90,
  },
];

type Report = {
  verdict: string;
  metrics: Record<string, number | null | Record<string, number>>;
  criteria: { key: string; passed: boolean; actual: number | null }[];
};

async function metrics(): Promise<Report> {
  // A failing criterion is a non-zero exit by design, so the report is read
  // from the error as readily as from the success.
  try {
    const { stdout } = await run("node", ["scripts/booking-metrics.mjs"], { env: process.env });
    return JSON.parse(stdout) as Report;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) throw error;
    return JSON.parse(stdout) as Report;
  }
}

describe("booking metrics report", () => {
  let organizationId: string;
  let locationId: string;
  let specialistId: string;
  let clientId: string;
  const now = new Date("2026-09-01T09:00:00.000Z");

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    locationId = (await createLocation(organizationId)).id;
    specialistId = (await createSpecialist(organizationId)).id;
    clientId = (await createClient(organizationId, { normalizedPhone: "+37369123456" })).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("counts appointments, holds and queued messages from the real tables", async () => {
    const bookingId = await withTenant(organizationId, async (tx) => {
      const created = await createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        clientId,
        interval: {
          start: new Date("2026-09-02T07:00:00.000Z"),
          end: new Date("2026-09-02T08:30:00.000Z"),
        },
        source: "public_booking",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now,
      });
      if (!created.ok) throw new Error("fixture booking was refused");
      await notifyBooking(tx, {
        organizationId,
        bookingId: created.bookingId,
        template: "booking.confirmed",
      });
      return created.bookingId;
    });

    await withTenant(organizationId, async (tx) => {
      const held = await holdSlot(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: {
          start: new Date("2026-09-02T12:00:00.000Z"),
          end: new Date("2026-09-02T13:00:00.000Z"),
        },
        now,
      });
      if (!held.ok) throw new Error("fixture hold was refused");
    });

    const report = await metrics();

    expect(report.metrics.bookings_total).toBe(1);
    expect(report.metrics.active_bookings).toBe(1);
    expect(report.metrics.bookings_by_source).toEqual({ public_booking: 1 });
    expect(report.metrics.holds_active).toBe(1);
    expect(report.metrics.notifications_queued).toBe(1);
    // Nothing has been sent yet, so there is no delivery rate to report — and
    // the gate does not pass on an absence of data.
    expect(report.metrics.notification_delivery_rate).toBeNull();
    expect(report.verdict).toBe("NOT_READY");
    expect(bookingId).toBeTruthy();
  });

  test("reports zero overlapping appointments while the constraints hold", async () => {
    await withTenant(organizationId, async (tx) => {
      for (const hour of [7, 9, 11]) {
        const created = await createBooking(tx, {
          organizationId,
          locationId,
          specialistId,
          interval: {
            start: new Date(Date.UTC(2026, 8, 2, hour)),
            end: new Date(Date.UTC(2026, 8, 2, hour + 1)),
          },
          source: "staff",
          confirmationMode: "instant",
          lines: LINES,
          actorUserId: null,
          now,
        });
        if (!created.ok) throw new Error("fixture booking was refused");
      }
    });

    const report = await metrics();

    expect(report.metrics.overlapping_active_bookings).toBe(0);
    expect(report.criteria.find((row) => row.key === "no_overlapping_bookings")).toMatchObject({
      actual: 0,
      passed: true,
    });
  });

  test("finds an overlap the moment one exists", async () => {
    /**
     * The overlap is written past both the application and the constraint,
     * because the point of this query is to answer the gate's question from the
     * data rather than to repeat what the schema already refuses. A check that
     * can only ever return zero says nothing, and this is the only way to know
     * which of the two it is.
     */
    const { adminDb } = await import("../helpers/database");
    const { bookings } = await import("@/db/schema");
    const { sql } = await import("drizzle-orm");

    await withTenant(organizationId, async (tx) => {
      const created = await createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: {
          start: new Date("2026-09-02T07:00:00.000Z"),
          end: new Date("2026-09-02T08:30:00.000Z"),
        },
        source: "staff",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now,
      });
      if (!created.ok) throw new Error("fixture booking was refused");
    });

    await adminDb.execute(
      sql`alter table booking drop constraint "booking_specialist_no_overlap"`,
    );
    try {
      await adminDb.insert(bookings).values({
        organizationId,
        locationId,
        specialistId,
        startsAt: new Date("2026-09-02T08:00:00.000Z"),
        endsAt: new Date("2026-09-02T09:00:00.000Z"),
        status: "confirmed",
        source: "staff",
      });

      const report = await metrics();
      expect(report.metrics.overlapping_active_bookings).toBe(1);
      expect(report.criteria.find((row) => row.key === "no_overlapping_bookings")).toMatchObject({
        passed: false,
      });
      expect(report.verdict).toBe("NOT_READY");
    } finally {
      await adminDb.execute(sql`
        delete from booking where starts_at = '2026-09-02T08:00:00.000Z'::timestamptz
      `);
      await adminDb.execute(sql`
        alter table booking add constraint "booking_specialist_no_overlap"
          exclude using gist (
            organization_id with =,
            specialist_id with =,
            tstzrange(starts_at, ends_at, '[)') with &&
          ) where (status in ('pending_confirmation', 'confirmed'))
      `);
    }
  });
});
