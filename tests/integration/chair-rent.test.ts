import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { chairRents, specialists, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadDashboard } from "@/lib/dashboard";
import { endChairRent } from "@/lib/cooperation";
import { loadPeriodPL, monthBounds } from "@/lib/period";
import { recordCompletedVisit } from "@/lib/visit-service";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * A studio that lets a chair, read on real rows.
 *
 * One master on 40% and one renting a chair for 3 000 a month. The studio's
 * revenue is the first one's visits and the rent — never the renter's visits,
 * which stay theirs: in the calendar, in their own report, and out of the
 * studio's. Moving the renter onto a percentage in the middle of the month
 * changes the visits closed after it and none of the visits closed before.
 */
describe("a rented chair in the month's report", () => {
  const CATALOGUE_FROM = new Date("2025-01-01T00:00:00.000Z");
  const MONTH = "2026-03";
  const RENT = 3_000_00;

  let ownerId: string;
  let organizationId: string;
  let serviceId: string;
  let hiredId: string;
  let renterId: string;

  async function closeVisit(specialistId: string, at: string) {
    return withTenant(organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId,
        actor: { userId: ownerId, role: "owner" },
        serviceId,
        specialistId,
        clientId: null,
        addOnIds: [],
        completedAt: new Date(at),
        actualDurationMinutes: 90,
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result.visit;
    });
  }

  function report() {
    return withTenant(organizationId, (tx) => loadPeriodPL(tx, { month: MONTH, currency: "MDL", organizationId }, "ru"));
  }

  function dashboard(specialistId: string | null) {
    const { from, to } = monthBounds(MONTH);
    return withTenant(organizationId, (tx) => loadDashboard(tx, { from, to, specialistId }, "ru"));
  }

  beforeEach(async () => {
    await resetDatabase();
    ownerId = (await createUser()).id;
    organizationId = (await createOrganization({ ownerId })).id;
    serviceId = (await createService(organizationId, { priceMinor: 600_00, durationMinutes: 90 })).id;

    hiredId = (await createSpecialist(organizationId, { name: "Процент" })).id;
    await createCommissionRule(organizationId, hiredId, { basisPoints: 4_000, activeFrom: CATALOGUE_FROM });

    renterId = (await createSpecialist(organizationId, { name: "Арендатор", cooperationType: "rent" })).id;
    await createCommissionRule(organizationId, renterId, { basisPoints: 0, activeFrom: CATALOGUE_FROM });
    await adminDb.insert(chairRents).values({
      organizationId,
      specialistId: renterId,
      amountMinor: RENT,
      activeFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("counts the hired master's visits and the rent, and not the renter's visits", async () => {
    await closeVisit(hiredId, "2026-03-03T10:00:00.000Z");
    await closeVisit(hiredId, "2026-03-04T10:00:00.000Z");
    await closeVisit(renterId, "2026-03-03T12:00:00.000Z");
    await closeVisit(renterId, "2026-03-05T12:00:00.000Z");
    await closeVisit(renterId, "2026-03-06T12:00:00.000Z");

    const { pl, cashFlow, masterBreakdown, chairRents: rents } = await report();

    expect(pl.visitRevenueMinor).toBe(1_200_00);
    expect(pl.chairRentMinor).toBe(RENT);
    expect(pl.revenueMinor).toBe(1_200_00 + RENT);
    expect(pl.contributionMarginMinor).toBe(720_00 + RENT);
    expect(cashFlow.revenueMinor).toBe(1_200_00);
    expect(cashFlow.chairRentMinor).toBe(RENT);
    expect(masterBreakdown.map((row) => row.specialistId)).toEqual([hiredId]);
    expect(rents).toEqual([{ specialistId: renterId, name: "Арендатор", amountMinor: RENT }]);

    // The studio's dashboard and ranking leave them out…
    const studio = await dashboard(null);
    expect(studio.metrics.visits).toBe(2);
    expect(studio.metrics.ranking.reduce((total, row) => total + row.visits, 0)).toBe(2);
    // …and the renter's own report is all three of them.
    const own = await dashboard(renterId);
    expect(own.metrics.visits).toBe(3);
    expect(own.metrics.revenueMinor).toBe(1_800_00);
  });

  it("snapshots the cooperation, so a change mid-month moves only the visits after it", async () => {
    const before = await closeVisit(renterId, "2026-03-05T12:00:00.000Z");

    // On the 15th the renter goes onto 40%: the card, the rule and the rent
    // change the way the endpoint changes them.
    const switchedAt = new Date("2026-03-15T09:00:00.000Z");
    await adminDb.update(specialists).set({ cooperationType: "commission" }).where(eq(specialists.id, renterId));
    await createCommissionRule(organizationId, renterId, { basisPoints: 4_000, activeFrom: switchedAt });
    await withTenant(organizationId, (tx) =>
      endChairRent(tx, { organizationId, userId: ownerId, requestId: "test" }, renterId, switchedAt),
    );

    const after = await closeVisit(renterId, "2026-03-20T12:00:00.000Z");

    const [beforeRow] = await adminDb.select().from(visits).where(eq(visits.id, before.id));
    const [afterRow] = await adminDb.select().from(visits).where(eq(visits.id, after.id));
    expect(beforeRow.masterCooperation).toBe("rent");
    expect(afterRow.masterCooperation).toBe("commission");

    const { pl } = await report();
    // The visit from the 20th is the studio's now; the one from the 5th is
    // still the renter's. The month the rent ended in is owed whole.
    expect(pl.visitRevenueMinor).toBe(600_00);
    expect(pl.chairRentMinor).toBe(RENT);

    // April owes no rent at all.
    const april = await withTenant(organizationId, (tx) =>
      loadPeriodPL(tx, { month: "2026-04", currency: "MDL", organizationId }, "ru"),
    );
    expect(april.pl.chairRentMinor).toBe(0);
  });

  it("leaves a visit closed before the snapshot existed in the studio's revenue", async () => {
    const old = await closeVisit(renterId, "2026-03-05T12:00:00.000Z");
    await adminDb.update(visits).set({ masterCooperation: null }).where(eq(visits.id, old.id));

    const { pl } = await report();
    expect(pl.visitRevenueMinor).toBe(600_00);
  });
});
