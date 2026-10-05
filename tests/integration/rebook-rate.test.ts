import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { bookings, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadRebookRate } from "@/lib/rebook-rate";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createClient,
  createLocation,
  createOrganization,
  createSpecialist,
  createUser,
  createVisit,
} from "../helpers/factories";

/**
 * The query half of «Записались на следующий раз»: which visits reach
 * `rebookRate` and what was booked from them. The rule itself is unit-tested in
 * `domain/rebook-rate.test.ts`.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("the rate of visits that booked the next one", () => {
  let organizationId: string;
  let locationId: string;
  let irina: string;
  let olga: string;
  let clientId: string;
  /** Every appointment takes an hour of its own: the exclusion constraint is real. */
  let hour = 0;

  async function appointment(
    specialistId: string,
    status: "completed" | "confirmed" | "cancelled",
    rebookedFromBookingId: string | null = null,
  ) {
    const startsAt = new Date(Date.UTC(2026, 0, 1) + hour++ * HOUR);
    const [row] = await adminDb
      .insert(bookings)
      .values({
        organizationId,
        locationId,
        specialistId,
        clientId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR - 1),
        status,
        source: rebookedFromBookingId ? "rebooking" : "staff",
        rebookedFromBookingId,
        ...(status === "cancelled" ? { cancelledAt: new Date(), cancelledBy: "client" as const } : {}),
      })
      .returning({ id: bookings.id });
    return row.id;
  }

  /** A visit closed from an appointment, `daysAgo` days ago. */
  async function closedVisit(specialistId: string, daysAgo: number, client: string | null = clientId) {
    const bookingId = await appointment(specialistId, "completed");
    const visit = await createVisit(organizationId, {
      specialistId,
      clientId: client,
      completedAt: new Date(Date.now() - daysAgo * DAY),
    });
    // `createVisit` knows nothing of bookings; the link is what this suite is about.
    await adminDb.update(visits).set({ bookingId }).where(eq(visits.id, visit.id));
    return bookingId;
  }

  function rate(filters: { from?: Date; to?: Date; specialistId?: string | null } = {}) {
    return withTenant(organizationId, (tx) => loadRebookRate(tx, filters));
  }

  beforeEach(async () => {
    await resetDatabase();
    hour = 0;
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    locationId = (await createLocation(organizationId)).id;
    irina = (await createSpecialist(organizationId)).id;
    olga = (await createSpecialist(organizationId)).id;
    clientId = (await createClient(organizationId)).id;
  });

  it("counts visits from the calendar with a client, and the ones booked again and kept", async () => {
    const kept = await closedVisit(irina, 3);
    const cancelled = await closedVisit(irina, 4);
    await closedVisit(irina, 5);
    await appointment(irina, "confirmed", kept);
    await appointment(irina, "cancelled", cancelled);

    // A visit recorded by hand has no button to have pressed, and one without a
    // client has nobody to book.
    await createVisit(organizationId, { specialistId: irina, clientId, completedAt: new Date() });
    await closedVisit(irina, 2, null);

    expect(await rate()).toEqual({ eligible: 3, rebooked: 1, rateBasisPoints: 3_333 });
  });

  it("reads the report's period, by when the visit was closed", async () => {
    const recent = await closedVisit(irina, 2);
    const old = await closedVisit(irina, 40);
    await appointment(irina, "confirmed", recent);
    await appointment(irina, "confirmed", old);

    const lastMonth = await rate({ from: new Date(Date.now() - 30 * DAY), to: new Date() });
    expect(lastMonth).toEqual({ eligible: 1, rebooked: 1, rateBasisPoints: 10_000 });
  });

  it("narrows to one master the way the report does", async () => {
    const hers = await closedVisit(irina, 2);
    await closedVisit(olga, 2);
    await appointment(irina, "confirmed", hers);

    expect(await rate({ specialistId: olga })).toEqual({ eligible: 1, rebooked: 0, rateBasisPoints: 0 });
    expect(await rate({ specialistId: irina })).toEqual({ eligible: 1, rebooked: 1, rateBasisPoints: 10_000 });
  });

  it("has no rate at all where nothing was closed from the calendar", async () => {
    await createVisit(organizationId, { specialistId: irina, clientId, completedAt: new Date() });
    expect((await rate()).rateBasisPoints).toBeNull();
  });
});
