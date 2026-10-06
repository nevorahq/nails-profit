import { beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { expenses, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { MemberRole } from "@/domain/rbac";
import { loadHeadline } from "@/lib/headline";
import { loadPeriodPL } from "@/lib/period";
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
 * The figure `/app` opens with against «Месяц подробно», on the same rows.
 *
 * Phase 4's one promise: the owner's «в этом месяце вам осталось» is the
 * operating profit of the monthly report, not a second reading of it. Checked
 * on the two shapes where the two most easily part — somebody working alone
 * whose own commission is added back below the margin, and a studio where the
 * owner works beside a hired master — with rent, a purchase and a visit across
 * the month's edge in the data.
 */
describe("the report's headline figure", () => {
  const CATALOGUE_FROM = new Date("2025-01-01T00:00:00.000Z");
  const MONTH = "2026-03";

  let ownerId: string;
  let organizationId: string;
  let serviceId: string;

  async function closeVisit(specialistId: string, at: Date) {
    return withTenant(organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId,
        actor: { userId: ownerId, role: "owner" },
        serviceId,
        specialistId,
        clientId: null,
        addOnIds: [],
        completedAt: at,
        actualDurationMinutes: 90,
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result;
    });
  }

  async function spend(name: string, category: "rent" | "materials", amountMinor: number, spentOn: string) {
    await adminDb.insert(expenses).values({
      organizationId,
      name,
      category,
      spentOn,
      amountMinor,
      currency: "MDL",
      isRecurring: false,
      recurringFrom: null,
      recurringTo: null,
    });
  }

  function report() {
    return withTenant(organizationId, (tx) =>
      loadPeriodPL(tx, { month: MONTH, currency: "MDL", organizationId }, "ru"),
    );
  }

  function headline(role: MemberRole, ownSpecialistId: string | null = null) {
    return withTenant(organizationId, (tx) =>
      loadHeadline(tx, { role, month: MONTH, currency: "MDL", organizationId, ownSpecialistId }, "ru"),
    );
  }

  beforeEach(async () => {
    await resetDatabase();
    ownerId = (await createUser()).id;
    organizationId = (await createOrganization({ ownerId })).id;
    serviceId = (await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 })).id;
  });

  it("is the monthly report's operating profit for somebody working alone", async () => {
    const me = (await createSpecialist(organizationId, { name: "Я", isPrincipal: true })).id;
    await createCommissionRule(organizationId, me, { basisPoints: 4_000, activeFrom: CATALOGUE_FROM });

    await closeVisit(me, new Date("2026-03-04T10:00:00.000Z"));
    await closeVisit(me, new Date("2026-03-19T10:00:00.000Z"));
    // Outside the month on either side: in neither figure.
    await closeVisit(me, new Date("2026-02-28T22:00:00.000Z"));
    await closeVisit(me, new Date("2026-04-01T00:30:00.000Z"));
    await spend("Аренда", "rent", 30_000, "2026-03-01");
    await spend("Гель", "materials", 10_000, "2026-03-02");

    const { pl } = await report();
    const card = await headline("owner");

    // The add-back is what makes this case worth a database: the margin alone
    // is 720 MDL, and the owner's own 480 of commission comes back below it.
    expect(pl.principalLabourMinor).toBe(48_000);
    expect(pl.operatingProfitMinor).toBe(80_000);
    expect(card.kind).toBe("operating");
    expect(card.amountMinor).toBe(pl.operatingProfitMinor);
    expect(card).toMatchObject({ revenueMinor: pl.revenueMinor, costsMinor: pl.revenueMinor - pl.operatingProfitMinor });
  });

  it("is the monthly report's operating profit for a studio, and a loss when the month is one", async () => {
    await adminDb.update(organizations).set({ type: "studio" }).where(eq(organizations.id, organizationId));
    const owner = (await createSpecialist(organizationId, { name: "Владелица", isPrincipal: true })).id;
    const masterUser = (await createUser()).id;
    const hired = (await createSpecialist(organizationId, { name: "Мастер", userId: masterUser })).id;
    await createCommissionRule(organizationId, owner, { basisPoints: 4_000, activeFrom: CATALOGUE_FROM });
    await createCommissionRule(organizationId, hired, { basisPoints: 5_000, activeFrom: CATALOGUE_FROM });

    await closeVisit(owner, new Date("2026-03-04T10:00:00.000Z"));
    await closeVisit(hired, new Date("2026-03-05T10:00:00.000Z"));
    await closeVisit(hired, new Date("2026-03-06T10:00:00.000Z"));
    await spend("Аренда", "rent", 150_000, "2026-03-01");

    const { pl } = await report();
    expect(pl.operatingProfitMinor).toBeLessThan(0);

    const owners = await headline("owner");
    expect(owners.amountMinor).toBe(pl.operatingProfitMinor);

    // The roles that cannot see the rent read the line above it, the same
    // line the report prints as «Маржинальная прибыль».
    for (const role of ["manager", "analyst"] as const) {
      const card = await headline(role);
      expect(card.kind, role).toBe("contribution");
      expect(card.amountMinor, role).toBe(pl.contributionMarginMinor);
    }

    // A master reads what the report pays them, and nobody else's.
    const masters = await headline("master", hired);
    expect(masters.kind).toBe("earnings");
    expect(masters.amountMinor).toBe(60_000);
    const breakdown = (await report()).masterBreakdown.find((line) => line.specialistId === hired);
    expect(masters.amountMinor).toBe(breakdown?.compensationMinor);
  });

  it("gives a master with no card of their own nothing rather than everybody's", async () => {
    const someone = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, someone, { basisPoints: 4_000, activeFrom: CATALOGUE_FROM });
    await closeVisit(someone, new Date("2026-03-04T10:00:00.000Z"));

    expect((await headline("master", null)).amountMinor).toBe(0);
  });

  it("gives a master renting a chair the takings of their visits, not a 0% commission", async () => {
    const renter = (await createSpecialist(organizationId, { name: "Аренда", cooperationType: "rent" })).id;
    await createCommissionRule(organizationId, renter, { basisPoints: 0, activeFrom: CATALOGUE_FROM });
    await closeVisit(renter, new Date("2026-03-04T10:00:00.000Z"));
    await closeVisit(renter, new Date("2026-03-05T10:00:00.000Z"));

    const card = await headline("master", renter);
    expect(card).toEqual({ kind: "takings", amountMinor: 120_000, floor: null });

    // The studio's own card is not changed by them: a renter's visits are out
    // of the studio's month, whose takings from the chair are the rent.
    expect((await headline("owner")).kind).toBe("operating");
    expect((await report()).pl.visitRevenueMinor).toBe(0);
  });

  it("names a renter's empty month by their card", async () => {
    const renter = (await createSpecialist(organizationId, { name: "Пустой месяц", cooperationType: "rent" })).id;
    expect(await headline("master", renter)).toEqual({ kind: "takings", amountMinor: 0, floor: null });
  });
});

