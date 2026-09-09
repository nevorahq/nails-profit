import { beforeEach, describe, expect, it } from "vitest";

import { bookings } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadUpcomingByUser } from "@/lib/team-workload";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createLocation,
  createOrganization,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The number the «Удалить» button on the team screen owes the person pressing
 * it: how many clients are booked with this colleague from now on.
 *
 * Every fact here lives in the gap between two tables — a booking's status and
 * its hour, against the account behind the specialist it names — so a unit test
 * cannot reach any of them.
 */
describe("upcoming work per member", () => {
  let organizationId: string;
  let locationId: string;
  let userId: string;
  let specialistId: string;

  const HOUR = 60 * 60 * 1000;
  /*
   * Distinct hours, because `booking_specialist_no_overlap` is a real
   * exclusion constraint: one specialist cannot hold two overlapping ranges,
   * which is the availability engine's rule enforced by the database.
   */
  const soon = (hoursAhead: number) => new Date(Date.now() + hoursAhead * HOUR);

  async function book(
    startsAt: Date,
    status: "pending_confirmation" | "confirmed" | "cancelled",
    onSpecialist = specialistId,
  ) {
    await adminDb.insert(bookings).values({
      organizationId,
      locationId,
      specialistId: onSpecialist,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR),
      status,
      source: "staff",
      // `booking_cancellation_shape` insists the three cancellation columns
      // arrive together or not at all.
      ...(status === "cancelled"
        ? { cancelledAt: new Date(), cancelledBy: "staff" as const }
        : {}),
    });
  }

  function counted() {
    return withTenant(organizationId, (tx) => loadUpcomingByUser(tx));
  }

  beforeEach(async () => {
    await resetDatabase();
    const owner = await createUser();
    organizationId = (await createOrganization({ ownerId: owner.id })).id;
    locationId = (await createLocation(organizationId)).id;
    userId = (await createUser()).id;
    specialistId = (await createSpecialist(organizationId, { userId })).id;
  });

  it("counts the hours somebody is still expected in", async () => {
    await book(soon(48), "confirmed");
    await book(soon(50), "pending_confirmation");

    expect((await counted()).get(userId)).toBe(2);
  });

  it("does not count what is already behind them", async () => {
    // Removing somebody does not un-work the visits they did; the warning is
    // about clients still waiting, and yesterday's client is not waiting.
    await book(soon(-48), "confirmed");

    expect((await counted()).has(userId)).toBe(false);
  });

  it("does not count an hour a client already gave back", async () => {
    await book(soon(48), "cancelled");

    expect((await counted()).has(userId)).toBe(false);
  });

  it("says nothing about a card no account answers to", async () => {
    /*
     * The team screen knows people by the account they signed in with, and a
     * card with no account cannot be removed from it at all — so counting one
     * would attach a warning to a button that does not exist.
     */
    const orphan = await createSpecialist(organizationId);
    await book(soon(48), "confirmed", orphan.id);

    expect(await counted()).toEqual(new Map());
  });
});
