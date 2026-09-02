import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { bookings } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  createBooking,
  rescheduleBooking,
  transitionBooking,
  type BookingStatus,
} from "@/lib/booking-service";
import { isExclusionViolation } from "@/lib/db-errors";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import {
  createLocation,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The state machine a booking moves through, against real PostgreSQL.
 *
 * The HTTP suite covers the endpoints; this covers the rules underneath them,
 * including the ones no endpoint can reach on its own — a request that arrives
 * pending only comes from the public page, which does not exist yet, and the
 * transition out of it has to be right before it does.
 */
const SLOT = {
  start: new Date("2026-09-02T07:00:00.000Z"),
  end: new Date("2026-09-02T08:30:00.000Z"),
};

const LATER = {
  start: new Date("2026-09-02T11:00:00.000Z"),
  end: new Date("2026-09-02T12:30:00.000Z"),
};

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

describe("booking transitions", () => {
  let organizationId: string;
  let specialistId: string;
  let otherSpecialistId: string;
  let locationId: string;
  const now = new Date("2026-09-01T09:00:00.000Z");

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    locationId = (await createLocation(organizationId)).id;
    specialistId = (await createSpecialist(organizationId)).id;
    otherSpecialistId = (await createSpecialist(organizationId, { name: "Второй мастер" })).id;
    await createService(organizationId);
  });

  async function makeBooking(
    options: {
      interval?: { start: Date; end: Date };
      specialist?: string;
      mode?: "instant" | "manual";
    } = {},
  ) {
    const created = await withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId: options.specialist ?? specialistId,
        interval: options.interval ?? SLOT,
        source: options.mode === "manual" ? "public_booking" : "staff",
        confirmationMode: options.mode ?? "instant",
        confirmationTtlMinutes: 120,
        lines: LINES,
        actorUserId: null,
        now,
      }),
    );
    if (!created.ok) throw new Error(`expected a booking, got ${created.conflict}`);
    return created.bookingId;
  }

  function move(bookingId: string, to: BookingStatus, expectedVersion?: number) {
    return withTenant(organizationId, (tx) =>
      transitionBooking(tx, {
        bookingId,
        to,
        expectedVersion: expectedVersion ?? null,
        actor: to === "cancelled" ? "staff" : undefined,
        reason: to === "cancelled" ? "client_request" : null,
        actorUserId: null,
        now,
      }),
    );
  }

  test("confirming a request clears the deadline that would have cancelled it", async () => {
    const bookingId = await makeBooking({ mode: "manual" });

    const [before] = await adminDb.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(before.status).toBe("pending_confirmation");
    expect(before.confirmationDueAt).not.toBeNull();

    const confirmed = await move(bookingId, "confirmed");
    expect(confirmed).toMatchObject({ ok: true });

    const [after] = await adminDb.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(after.status).toBe("confirmed");
    // Left behind, the deadline would have the repair job cancel an appointment
    // that is on.
    expect(after.confirmationDueAt).toBeNull();
    expect(after.confirmedAt).not.toBeNull();
  });

  test("a terminal booking stays terminal", async () => {
    const cancelled = await makeBooking();
    await move(cancelled, "cancelled");
    expect(await move(cancelled, "confirmed")).toMatchObject({ failure: "illegal_transition" });
    expect(await move(cancelled, "completed")).toMatchObject({ failure: "illegal_transition" });

    const requested = await makeBooking({ interval: LATER, mode: "manual" });
    // A no-show on an appointment the studio never agreed to would record the
    // client failing to attend something that was never arranged.
    expect(await move(requested, "no_show")).toMatchObject({ failure: "illegal_transition" });
  });

  test("two people answering the same request produce one change", async () => {
    const bookingId = await makeBooking({ mode: "manual" });
    const [before] = await adminDb.select().from(bookings).where(eq(bookings.id, bookingId));

    const attempts = await Promise.all([
      move(bookingId, "confirmed", before.version),
      move(bookingId, "cancelled", before.version),
    ]);

    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(attempts.filter((result) => !result.ok)).toHaveLength(1);
  });

  test("moving an appointment releases the slot it was in", async () => {
    const bookingId = await makeBooking();

    const moved = await withTenant(organizationId, (tx) =>
      rescheduleBooking(tx, {
        organizationId,
        bookingId,
        interval: LATER,
        actorUserId: null,
        now,
      }),
    );
    expect(moved).toMatchObject({ ok: true });

    // The vacated time is immediately sellable — an exclusion constraint over
    // the old row would have kept it dead.
    const replacement = await makeBooking();
    expect(replacement).toBeTruthy();
  });

  test("a closed appointment keeps the hour it was closed in", async () => {
    const bookingId = await makeBooking();
    // Closing a visit that has not happened yet is a mistake a studio makes,
    // and the hour must not go back on sale behind a client who is still
    // expecting to be seen in it.
    expect(await move(bookingId, "completed")).toMatchObject({ ok: true });

    const clash = await withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: SLOT,
        source: "public_booking",
        confirmationMode: "manual",
        confirmationTtlMinutes: 120,
        lines: LINES,
        actorUserId: null,
        now,
      }),
    );
    expect(clash).toMatchObject({ ok: false, conflict: "booking" });
  });

  test("a cancelled appointment is the one that gives its hour back", async () => {
    // The other side of the rule above: cancelling is the act that means the
    // time is free again, and it is the only one.
    const bookingId = await makeBooking();
    expect(await move(bookingId, "cancelled")).toMatchObject({ ok: true });

    expect(await makeBooking()).toBeTruthy();
  });

  test("an appointment cannot be moved onto a colleague's booked time", async () => {
    const mine = await makeBooking();
    await makeBooking({ interval: LATER, specialist: otherSpecialistId });

    const clash = await withTenant(organizationId, (tx) =>
      rescheduleBooking(tx, {
        organizationId,
        bookingId: mine,
        interval: LATER,
        specialistId: otherSpecialistId,
        actorUserId: null,
        now,
      }),
    );

    expect(clash).toMatchObject({ ok: false, failure: "conflict", conflict: "booking" });
  });

  test("moving a request forward never pushes its deadline past the appointment", async () => {
    // Requested two hours before the slot, so the deadline already sits at the
    // start. Moving it earlier must bring the deadline with it.
    const closeToStart = new Date(LATER.start.getTime() - 60 * 60_000);
    const created = await withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: LATER,
        source: "public_booking",
        confirmationMode: "manual",
        confirmationTtlMinutes: 120,
        lines: LINES,
        actorUserId: null,
        now: closeToStart,
      }),
    );
    if (!created.ok) throw new Error("expected a booking");

    await withTenant(organizationId, (tx) =>
      rescheduleBooking(tx, {
        organizationId,
        bookingId: created.bookingId,
        interval: SLOT,
        actorUserId: null,
        now: closeToStart,
      }),
    );

    const [row] = await adminDb.select().from(bookings).where(eq(bookings.id, created.bookingId));
    expect(row.confirmationDueAt!.getTime()).toBeLessThanOrEqual(SLOT.start.getTime());
  });

  test("twenty simultaneous moves onto one slot leave one winner", async () => {
    const contenders = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        makeBooking({
          interval: {
            start: new Date(SLOT.start.getTime() + index * 2 * 60 * 60_000),
            end: new Date(SLOT.end.getTime() + index * 2 * 60 * 60_000),
          },
        }),
      ),
    );

    const target = {
      start: new Date("2026-09-10T07:00:00.000Z"),
      end: new Date("2026-09-10T08:30:00.000Z"),
    };

    const attempts = await Promise.all(
      contenders.map((bookingId) =>
        withTenant(organizationId, (tx) =>
          rescheduleBooking(tx, { organizationId, bookingId, interval: target, actorUserId: null, now }),
        ).catch((error) => {
          // The constraint firing is a lost race, not a failed test.
          if (isExclusionViolation(error)) return { ok: false as const, failure: "conflict" as const };
          throw error;
        }),
      ),
    );

    expect(attempts.filter((result) => result.ok)).toHaveLength(1);

    const landed = await adminDb
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.startsAt, target.start));
    expect(landed).toHaveLength(1);
  }, 60_000);
});

afterAll(async () => {
  await closeTestConnections();
});
