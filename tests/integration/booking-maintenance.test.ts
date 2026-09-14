import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { bookingHolds, bookings, notificationOutbox, staffNotices } from "@/db/schema";
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

    /*
     * By SMS, because this client has no address — the fixture above gives them
     * a phone and `email: null`, which is what a studio typing somebody in from
     * a phone call produces. Before the fallback existed this row was written
     * and never sent: the queue held an email for a client with no inbox, and
     * the person who had been told «студия подтвердит» heard nothing more.
     *
     * One row, not two. The job used to queue both channels for every client,
     * which is the other half of what this asserts.
     *
     * Filtered to the client's own message, because the job now writes the
     * studio's as well: an unanswered request that lapses is news on both sides
     * of the counter, and the rows for the studio are the next test's subject.
     */
    const toClient = queued.filter((row) => row.template === "booking.cancelled");
    expect(toClient).toHaveLength(1);
    expect(toClient[0].channel).toBe("sms");

    // Running it again changes nothing: the same key, the same one message.
    await run("node", ["scripts/booking-maintenance.mjs"], { env: { ...process.env } });
    const afterSecondRun = await adminDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, bookingId));
    expect(afterSecondRun).toHaveLength(queued.length);
  });

  /**
   * The same lapse for a client who does have an address: one email, and no SMS
   * beside it.
   *
   * This is the branch that used to cost a studio money without anybody asking
   * for it. The job queued a row per channel for every client, so a client with
   * both contacts was texted a cancellation they were about to read in their
   * inbox — while a route cancelling the same booking sent only the email.
   */
  test("writes only the email when the client has one", async () => {
    const past = new Date(Date.now() - 3 * 60 * 60_000);
    const withAddress = await createClient(organizationId, {
      normalizedPhone: "+37369777888",
      email: "olga@example.com",
    });

    const bookingId = await withTenant(organizationId, async (tx) => {
      const created = await createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        clientId: withAddress.id,
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

    await run("node", ["scripts/booking-maintenance.mjs"], {
      env: { ...process.env, MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL },
    });

    const queued = await adminDb
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.bookingId, bookingId));

    const toClient = queued.filter((row) => row.template === "booking.cancelled");
    expect(toClient).toHaveLength(1);
    expect(toClient[0].channel).toBe("email");
  });

  /**
   * The studio's half of a lapse, which for as long as this job existed was
   * nothing at all.
   *
   * The client was told; inside the studio the request left «Ждут ответа» in
   * silence, and a list something silently leaves reads exactly like a list it
   * was never on. A master back at their phone three hours later could not tell
   * "I missed one" from "nobody asked" — and the hour is free again either way,
   * which is the part somebody could still have sold.
   */
  test("tells the studio its unanswered request lapsed", async () => {
    const past = new Date(Date.now() - 3 * 60 * 60_000);
    // A card with an account of its own, because whether there is an inbox to
    // write to is exactly what separates the message from the feed line.
    const masterUser = await createUser();
    const master = await createSpecialist(organizationId, { userId: masterUser.id });

    const bookingId = await withTenant(organizationId, async (tx) => {
      const created = await createBooking(tx, {
        organizationId,
        locationId,
        specialistId: master.id,
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

    await run("node", ["scripts/booking-maintenance.mjs"], {
      env: { ...process.env, MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL },
    });

    // The line first: it is the half that needs only a reader, so it goes in
    // whether or not any card carries an account.
    const notices = await adminDb
      .select()
      .from(staffNotices)
      .where(eq(staffNotices.bookingId, bookingId));
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe("request_expired");
    expect(notices[0].specialistId).toBe(master.id);
    // Nobody did this, so nobody is excluded from seeing it: the deadline did.
    expect(notices[0].actorUserId).toBeNull();

    /*
     * And a message each to the two people who can answer a request — the
     * master whose chair it was, and the owner. One row per person, exactly as
     * `notifyStaff` writes them, so one can dead-letter without taking the
     * other with it.
     */
    const toStudio = await adminDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.bookingId, bookingId),
          eq(notificationOutbox.template, "booking.staff_request_expired"),
        ),
      );
    expect(toStudio).toHaveLength(2);
    expect(toStudio.every((row) => row.channel === "email")).toBe(true);
    expect(toStudio.map((row) => row.payload?.recipient).sort()).toEqual(["owner", "specialist"]);

    // Twice a minute is the schedule this job runs on, and the second run has
    // to be a no-op on both halves rather than a second telling.
    await run("node", ["scripts/booking-maintenance.mjs"], { env: { ...process.env } });
    expect(
      await adminDb.select().from(staffNotices).where(eq(staffNotices.bookingId, bookingId)),
    ).toHaveLength(1);
    expect(
      await adminDb
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.bookingId, bookingId),
            eq(notificationOutbox.template, "booking.staff_request_expired"),
          ),
        ),
    ).toHaveLength(2);
  });
});
