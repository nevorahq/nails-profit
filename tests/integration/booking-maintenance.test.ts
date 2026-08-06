import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { bookingHolds, bookings, notificationOutbox } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { createBooking, holdSlot } from "@/lib/booking-service";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import {
  createClient,
  createLocation,
  createOrganization,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The repair job of sections 7.5 and 7.7, run as an operator runs it.
 *
 * Its SQL is written by hand against the tables rather than through the
 * application's types, which is exactly why it is worth executing: a column
 * renamed in `db/schema.ts` breaks this script silently, and the first symptom
 * in production would be slots nobody can book and clients nobody told.
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

describe("booking maintenance", () => {
  let organizationId: string;
  let specialistId: string;
  let locationId: string;
  let clientId: string;

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    locationId = (await createLocation(organizationId)).id;
    specialistId = (await createSpecialist(organizationId)).id;
    clientId = (
      await createClient(organizationId, { normalizedPhone: "+37369123456", email: null })
    ).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("expires abandoned holds, lapses unanswered requests and tells the client", async () => {
    const past = new Date(Date.now() - 3 * 60 * 60_000);

    const bookingId = await withTenant(organizationId, async (tx) => {
      // A request the studio never answered: its deadline is the appointment
      // itself, which has already gone by.
      const created = await createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        clientId,
        interval: { start: past, end: new Date(past.getTime() + 90 * 60_000) },
        source: "public_booking",
        confirmationMode: "manual",
        confirmationTtlMinutes: 120,
        lines: LINES,
        actorUserId: null,
        now: new Date(past.getTime() - 60 * 60_000),
      });
      if (!created.ok) throw new Error("fixture booking was refused");
      return created.bookingId;
    });

    // A hold nobody came back for, on a day no request will ever touch again.
    const holdId = await withTenant(organizationId, async (tx) => {
      const held = await holdSlot(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: {
          start: new Date(past.getTime() + 6 * 60 * 60_000),
          end: new Date(past.getTime() + 7 * 60 * 60_000),
        },
        ttlMinutes: 5,
        now: new Date(past.getTime() - 60 * 60_000),
      });
      if (!held.ok) throw new Error("fixture hold was refused");
      return held.holdId;
    });

    await run("node", ["scripts/booking-maintenance.mjs"], {
      env: {
        ...process.env,
        // The suite's setup already points these at the test database.
        MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
      },
    });

    const [booking] = await adminDb.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking.status).toBe("cancelled");
    expect(booking.cancelledBy).toBe("system");
    expect(booking.cancellationReason).toBe("confirmation_expired");

    const [hold] = await adminDb.select().from(bookingHolds).where(eq(bookingHolds.id, holdId));
    expect(hold.status).toBe("expired");

    // Section 7.7: a client told "the studio will confirm" has to hear that it
    // did not, and the message is written the same way a route writes it.
    const queued = await adminDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, bookingId));
    expect(queued.map((row) => row.template)).toContain("booking.cancelled");
    expect(queued.every((row) => row.status === "pending")).toBe(true);

    // Running it again changes nothing: the same key, the same one message.
    await run("node", ["scripts/booking-maintenance.mjs"], { env: { ...process.env } });
    const afterSecondRun = await adminDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, bookingId));
    expect(afterSecondRun).toHaveLength(queued.length);
  });
});
