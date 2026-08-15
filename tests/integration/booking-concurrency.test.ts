import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { bookingHolds, bookings, workplaces } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  ACTIVE_BOOKING_STATUSES,
  createBooking,
  expireUnconfirmedBookings,
  holdSlot,
  releaseHold,
  rescheduleBooking,
  sweepExpiredHolds,
} from "@/lib/booking-service";
import { isExclusionViolation } from "@/lib/db-errors";
import { claimIdempotencyKey, fingerprintOf, recordIdempotentResult } from "@/lib/idempotency";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import {
  createLocation,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * Roadmap section 7.5: "отдельный concurrency test запускает не менее 100
 * параллельных попыток занять один слот и допускает ровно одну подтверждённую
 * запись".
 *
 * This runs against real PostgreSQL because that is the only place the claim
 * can be tested. The advisory lock, the re-check inside it and the exclusion
 * constraint are three different mechanisms, and a mocked database would
 * exercise none of them.
 */
const SLOT = {
  start: new Date("2026-09-02T07:00:00.000Z"),
  end: new Date("2026-09-02T08:30:00.000Z"),
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

describe("double-booking protection", () => {
  let organizationId: string;
  let specialistId: string;
  let otherSpecialistId: string;
  let locationId: string;

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    const organization = await createOrganization({ ownerId: user.id });
    organizationId = organization.id;
    locationId = (await createLocation(organizationId)).id;
    specialistId = (await createSpecialist(organizationId)).id;
    otherSpecialistId = (await createSpecialist(organizationId, { name: "Второй мастер" })).id;
    await createService(organizationId);
  });

  function attempt(interval = SLOT, specialist = specialistId) {
    return withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId: specialist,
        interval,
        source: "staff",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now: new Date("2026-09-01T09:00:00.000Z"),
      }),
    ).catch((error) => {
      // The constraint firing is a lost race, not a failed test: it is the
      // outcome the fourth line of defence is there to produce.
      if (isExclusionViolation(error)) return { ok: false as const, conflict: "booking" as const };
      throw error;
    });
  }

  test("one hundred simultaneous attempts leave exactly one booking", async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => attempt()));

    const accepted = results.filter((result) => result.ok);
    expect(accepted).toHaveLength(1);

    const rows = await adminDb
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");

    // Everyone else was told the truth about why.
    expect(results.filter((result) => !result.ok && result.conflict === "booking")).toHaveLength(99);
  }, 60_000);

  test("simultaneous attempts on adjacent slots all succeed", async () => {
    // Half-open intervals: 07:00–08:30 and 08:30–10:00 are two clients in a
    // row, and serializing them must not turn into refusing them.
    const second = { start: SLOT.end, end: new Date(SLOT.end.getTime() + 90 * 60_000) };
    const results = await Promise.all([attempt(SLOT), attempt(second)]);

    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("two specialists are not serialized against each other", async () => {
    const results = await Promise.all([attempt(SLOT, specialistId), attempt(SLOT, otherSpecialistId)]);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("the database refuses an overlap even when the check is bypassed", async () => {
    await attempt();

    // Straight to the table, past every application check: this is what the
    // exclusion constraint exists for.
    await expect(
      adminDb.insert(bookings).values({
        organizationId,
        locationId,
        specialistId,
        startsAt: new Date("2026-09-02T08:00:00.000Z"),
        endsAt: new Date("2026-09-02T09:00:00.000Z"),
        status: "confirmed",
        source: "staff",
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23P01" }) });
  });

  test("a cancelled booking frees its slot for resale", async () => {
    const first = await attempt();
    expect(first.ok).toBe(true);

    await adminDb
      .update(bookings)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: "staff",
        cancellationReason: "client_request",
      })
      .where(eq(bookings.organizationId, organizationId));

    const second = await attempt();
    expect(second.ok).toBe(true);
  });
});

describe("holds", () => {
  let organizationId: string;
  let specialistId: string;
  let locationId: string;
  const now = new Date("2026-09-01T09:00:00.000Z");

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    const organization = await createOrganization({ ownerId: user.id });
    organizationId = organization.id;
    locationId = (await createLocation(organizationId)).id;
    specialistId = (await createSpecialist(organizationId)).id;
  });

  function hold(at = now, interval = SLOT) {
    return withTenant(organizationId, (tx) =>
      holdSlot(tx, { organizationId, locationId, specialistId, interval, now: at }),
    );
  }

  test("a hold reserves the slot against everyone else", async () => {
    const first = await hold();
    expect(first.ok).toBe(true);

    const second = await hold();
    expect(second).toMatchObject({ ok: false, conflict: "hold" });

    const booking = await withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: SLOT,
        source: "staff",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now,
      }),
    );
    expect(booking).toMatchObject({ ok: false, conflict: "hold" });
  });

  test("the holder converts their own hold rather than colliding with it", async () => {
    const held = await hold();
    if (!held.ok) throw new Error("expected a hold");

    const booking = await withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: SLOT,
        source: "public_booking",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        holdId: held.holdId,
        now,
      }),
    );

    expect(booking.ok).toBe(true);

    const [row] = await adminDb
      .select({ status: bookingHolds.status, converted: bookingHolds.convertedBookingId })
      .from(bookingHolds)
      .where(eq(bookingHolds.id, held.holdId));
    expect(row.status).toBe("converted");
    expect(row.converted).not.toBeNull();
  });

  test("an abandoned hold stops blocking the slot once it expires", async () => {
    const held = await hold();
    expect(held.ok).toBe(true);

    // Six minutes later, past the five-minute TTL. Nothing swept it: the next
    // request is what marks it expired, because an index predicate cannot
    // contain `now()`.
    const later = new Date(now.getTime() + 6 * 60_000);
    const second = await hold(later);
    expect(second.ok).toBe(true);

    const rows = await adminDb
      .select({ status: bookingHolds.status })
      .from(bookingHolds)
      .where(eq(bookingHolds.organizationId, organizationId));
    expect(rows.map((row) => row.status).sort()).toEqual(["active", "expired"]);
  });

  test("a released hold frees the slot immediately", async () => {
    const held = await hold();
    if (!held.ok) throw new Error("expected a hold");

    await withTenant(organizationId, (tx) => releaseHold(tx, held.holdId, now));

    const second = await hold();
    expect(second.ok).toBe(true);
  });

  test("the sweep releases everything that has run out", async () => {
    await hold();
    await hold(now, { start: new Date("2026-09-02T10:00:00.000Z"), end: new Date("2026-09-02T11:00:00.000Z") });

    const released = await withTenant(organizationId, (tx) =>
      sweepExpiredHolds(tx, new Date(now.getTime() + 10 * 60_000)),
    );
    expect(released).toBe(2);
  });

  test("the database refuses two active holds on one slot", async () => {
    await hold();

    await expect(
      adminDb.insert(bookingHolds).values({
        organizationId,
        locationId,
        specialistId,
        startsAt: new Date("2026-09-02T08:00:00.000Z"),
        endsAt: new Date("2026-09-02T09:00:00.000Z"),
        tokenHash: "duplicate",
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23P01" }) });
  });
});

describe("unanswered requests", () => {
  let organizationId: string;
  let specialistId: string;
  let locationId: string;
  const now = new Date("2026-09-01T09:00:00.000Z");

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    const organization = await createOrganization({ ownerId: user.id });
    organizationId = organization.id;
    locationId = (await createLocation(organizationId)).id;
    specialistId = (await createSpecialist(organizationId)).id;
  });

  test("a manual request holds the slot until it lapses, then frees it", async () => {
    const requested = await withTenant(organizationId, (tx) =>
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
    expect(requested).toMatchObject({ ok: true, status: "pending_confirmation" });

    // Pending occupies the specialist: an unanswered request still stops
    // someone else taking the time.
    const meanwhile = await withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: SLOT,
        source: "staff",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now,
      }),
    );
    expect(meanwhile).toMatchObject({ ok: false, conflict: "booking" });

    const expired = await withTenant(organizationId, (tx) =>
      expireUnconfirmedBookings(tx, new Date(now.getTime() + 3 * 60 * 60_000)),
    );
    expect(expired).toBe(1);

    const afterwards = await withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        interval: SLOT,
        source: "staff",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now: new Date(now.getTime() + 3 * 60 * 60_000),
      }),
    );
    expect(afterwards.ok).toBe(true);
  });

  test("the confirmation window never outlives the appointment", async () => {
    // A request made an hour before the slot cannot hold a two-hour window:
    // that would leave a booking nobody can act on.
    const closeToStart = new Date(SLOT.start.getTime() - 60 * 60_000);
    await withTenant(organizationId, (tx) =>
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
        now: closeToStart,
      }),
    );

    const [row] = await adminDb
      .select({ due: bookings.confirmationDueAt, status: bookings.status })
      .from(bookings)
      .where(
        and(
          eq(bookings.organizationId, organizationId),
          inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        ),
      );

    expect(row.due?.toISOString()).toBe(SLOT.start.toISOString());
  });
});

/**
 * The three sets section 7.12 asks for that the ones above do not cover:
 * a shared workplace, two moves onto one destination, and a retried request.
 */
describe("contended resources", () => {
  let organizationId: string;
  let locationId: string;
  let firstSpecialist: string;
  let secondSpecialist: string;
  let workplaceId: string;

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    locationId = (await createLocation(organizationId)).id;
    firstSpecialist = (await createSpecialist(organizationId)).id;
    secondSpecialist = (await createSpecialist(organizationId, { name: "Второй мастер" })).id;
    await createService(organizationId);

    const [workplace] = await adminDb
      .insert(workplaces)
      .values({ organizationId, locationId, name: "Кресло 1" })
      .returning();
    workplaceId = workplace.id;
  });

  function attempt(specialistId: string, interval = SLOT, workplace: string | null = workplaceId) {
    return withTenant(organizationId, (tx) =>
      createBooking(tx, {
        organizationId,
        locationId,
        specialistId,
        workplaceId: workplace,
        interval,
        source: "staff",
        confirmationMode: "instant",
        lines: LINES,
        actorUserId: null,
        now: new Date("2026-09-01T09:00:00.000Z"),
      }),
    ).catch((error) => {
      if (isExclusionViolation(error)) return { ok: false as const, conflict: "booking" as const };
      throw error;
    });
  }

  test("one chair cannot hold two clients, even with two specialists", async () => {
    // The specialists are free — this is the resource constraint of section
    // 7.5, and nothing about the specialist-based check would catch it.
    const results = await Promise.all([
      attempt(firstSpecialist),
      attempt(secondSpecialist),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rows = await adminDb
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.workplaceId, workplaceId));
    expect(rows).toHaveLength(1);
  });

  test("twenty attempts on one chair leave one booking", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        attempt(index % 2 === 0 ? firstSpecialist : secondSpecialist),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  test("two moves onto the same free slot: one lands, one is refused", async () => {
    const morning = { start: SLOT.start, end: SLOT.end };
    const midday = {
      start: new Date(SLOT.start.getTime() + 4 * 60 * 60_000),
      end: new Date(SLOT.end.getTime() + 4 * 60 * 60_000),
    };
    const destination = {
      start: new Date(SLOT.start.getTime() + 8 * 60 * 60_000),
      end: new Date(SLOT.end.getTime() + 8 * 60 * 60_000),
    };

    // Two appointments on one specialist, both moving to the same empty hour.
    const first = await attempt(firstSpecialist, morning, null);
    const second = await attempt(firstSpecialist, midday, null);
    if (!first.ok || !second.ok) throw new Error("fixture bookings were refused");

    const move = (bookingId: string) =>
      withTenant(organizationId, (tx) =>
        rescheduleBooking(tx, {
          organizationId,
          bookingId,
          interval: destination,
          expectedVersion: null,
          actorUserId: null,
          now: new Date("2026-09-01T09:00:00.000Z"),
        }),
      ).catch((error) => {
        if (isExclusionViolation(error)) {
          return { ok: false as const, failure: "conflict" as const };
        }
        throw error;
      });

    const results = await Promise.all([move(first.bookingId), move(second.bookingId)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const landed = await adminDb
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.specialistId, firstSpecialist), eq(bookings.startsAt, destination.start)));
    expect(landed).toHaveLength(1);
  });

  test("ten simultaneous retries of one request claim the key once", async () => {
    // What a phone on a bad connection actually does. The claim is written
    // before the booking and inside the same transaction, so the losers block
    // on the unique index rather than reading a row that is not there yet.
    const key = `retry-${crypto.randomUUID()}`;
    const fingerprint = fingerprintOf({ slot: SLOT.start.toISOString() });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenant(organizationId, async (tx) => {
          const claim = await claimIdempotencyKey(tx, {
            organizationId,
            scope: "booking.public_create",
            key,
            fingerprint,
          });
          if (claim.status !== "claimed") return claim;

          const created = await createBooking(tx, {
            organizationId,
            locationId,
            specialistId: firstSpecialist,
            interval: SLOT,
            source: "public_booking",
            confirmationMode: "instant",
            lines: LINES,
            actorUserId: null,
            now: new Date("2026-09-01T09:00:00.000Z"),
          });
          if (!created.ok) return { status: "conflict" as const };

          await recordIdempotentResult(tx, claim.id, created.bookingId);
          return { status: "claimed" as const, id: created.bookingId };
        }).catch((error) => {
          if (isExclusionViolation(error)) return { status: "conflict" as const };
          throw error;
        }),
      ),
    );

    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    const rows = await adminDb
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.organizationId, organizationId));
    expect(rows).toHaveLength(1);

    // And the retry that arrives afterwards is answered with that booking
    // rather than making a second one.
    const replay = await withTenant(organizationId, (tx) =>
      claimIdempotencyKey(tx, {
        organizationId,
        scope: "booking.public_create",
        key,
        fingerprint,
      }),
    );
    // `result` is null for a booking: the row itself is the answer, and the
    // stored counts exist for the mutations that produce no single row.
    expect(replay).toEqual({ status: "replay", bookingId: rows[0].id, result: null });
  });
});

afterAll(async () => {
  await closeTestConnections();
});
