import { beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { expenses, laborCostRules, organizations, ownerDraws, scheduleRules, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { ExpenseCategory } from "@/domain/expense-categories";
import { loadPeriodPL } from "@/lib/period";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createLocation,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";
import { recordCompletedVisit } from "@/lib/visit-service";

/**
 * The monthly report against real rows.
 *
 * The invariant worth a database for is the first one: the revenue in the P&L
 * is the sum of the latest snapshot of each visit, and nothing else. Everything
 * after it — which half of the ledger is subtracted, what a recurring row costs
 * in March — is arithmetic that `domain/period-pl.test.ts` already pins down;
 * what only this file can check is that the two readers agree.
 */
describe("the monthly P&L", () => {
  let userId: string;
  let organizationId: string;
  let specialistId: string;
  let serviceId: string;

  async function closeVisit(at: Date) {
    return withTenant(organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId,
        actor: { userId, role: "owner" },
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

  async function record(options: {
    name: string;
    category: ExpenseCategory;
    amountMinor: number;
    spentOn: string;
    isRecurring?: boolean;
    recurringFrom?: string;
    recurringTo?: string | null;
    currency?: "MDL" | "EUR";
  }) {
    await adminDb.insert(expenses).values({
      organizationId,
      name: options.name,
      category: options.category,
      spentOn: options.spentOn,
      amountMinor: options.amountMinor,
      currency: options.currency ?? "MDL",
      isRecurring: options.isRecurring ?? false,
      recurringFrom: options.isRecurring ? (options.recurringFrom ?? options.spentOn) : null,
      recurringTo: options.recurringTo ?? null,
    });
  }

  function report(month: string) {
    return withTenant(organizationId, (tx) => loadPeriodPL(tx, { month, currency: "MDL", organizationId }, "ru"));
  }

  /*
   * The catalogue is dated before every visit in this file. A commission rule
   * is chosen by `activeFrom <= completedAt`, so fixtures
   * created "now" would leave a visit dated last March with no rule at all —
   * which the service correctly refuses rather than costing at zero.
   */
  const CATALOGUE_FROM = new Date("2025-01-01T00:00:00.000Z");

  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
    organizationId = (await createOrganization({ ownerId: userId })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: CATALOGUE_FROM,
    });

    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    serviceId = service.id;
  });

  it("takes its revenue from the visits' own snapshots", async () => {
    const first = await closeVisit(new Date("2026-03-04T10:00:00.000Z"));
    const second = await closeVisit(new Date("2026-03-19T10:00:00.000Z"));

    const result = await report("2026-03");
    const { pl } = result;

    expect(pl.revenueMinor).toBe(first.snapshot.revenueMinor + second.snapshot.revenueMinor);
    expect(pl.contributionMarginMinor).toBe(
      first.snapshot.contributionMarginMinor! + second.snapshot.contributionMarginMinor!,
    );
    expect(pl.labourCostMinor).toBe(first.snapshot.commissionMinor! + second.snapshot.commissionMinor!);
  });

  it("counts a visit in the month it was completed in and no other", async () => {
    await closeVisit(new Date("2026-02-28T22:00:00.000Z"));
    await closeVisit(new Date("2026-03-01T02:00:00.000Z"));

    expect((await report("2026-02")).pl.revenueMinor).toBe(60_000);
    expect((await report("2026-03")).pl.revenueMinor).toBe(60_000);
    expect((await report("2026-04")).pl.revenueMinor).toBe(0);
  });

  it("subtracts the overhead and leaves the rest of the ledger out of the profit", async () => {
    await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
    await record({ name: "Аренда", category: "rent", amountMinor: 20_000, spentOn: "2026-03-01" });
    await record({ name: "Гель", category: "materials", amountMinor: 50_000, spentOn: "2026-03-02" });
    await record({ name: "Мастеру", category: "payroll", amountMinor: 24_000, spentOn: "2026-03-31" });

    const { pl } = await report("2026-03");

    // 600 − 240 commission = 360, less 200 of rent and the 500 of gel that is
    // now an ordinary cost of the month it was bought in.
    expect(pl.contributionMarginMinor).toBe(36_000);
    expect(pl.overheadMinor).toBe(70_000);
    expect(pl.operatingProfitMinor).toBe(-34_000);
    // Only the wage is held back, and it is reported rather than hidden.
    expect(pl.cashOnlyMinor).toBe(24_000);
  });

  /*
   * A recurring row is written once, in January, and has to answer for June.
   * Filtering the ledger by period in SQL would drop exactly that row, which is
   * why `loadPeriodPL` reads the ledger whole and lets the domain decide.
   */
  it("charges a recurring expense to a month whose rows it does not appear in", async () => {
    await record({
      name: "Аренда",
      category: "rent",
      amountMinor: 20_000,
      spentOn: "2026-01-05",
      isRecurring: true,
    });

    for (const month of ["2026-01", "2026-06", "2027-02"]) {
      expect((await report(month)).pl.overheadMinor, month).toBe(20_000);
    }
    expect((await report("2025-12")).pl.overheadMinor).toBe(0);
  });

  it("stops charging it after it is ended, and leaves the months before alone", async () => {
    await record({
      name: "Аренда",
      category: "rent",
      amountMinor: 20_000,
      spentOn: "2026-01-05",
      isRecurring: true,
      recurringTo: "2026-03-20",
    });

    expect((await report("2026-02")).pl.overheadMinor).toBe(20_000);
    expect((await report("2026-03")).pl.overheadMinor).toBe(20_000);
    expect((await report("2026-04")).pl.overheadMinor).toBe(0);
  });

  it("keeps an archived row out of every month", async () => {
    await record({ name: "Ошибка", category: "rent", amountMinor: 99_000, spentOn: "2026-03-01" });
    await adminDb.update(expenses).set({ archivedAt: new Date() });

    expect((await report("2026-03")).pl.overheadMinor).toBe(0);
  });

  it("adds the owner's own commission back without touching the margin", async () => {
    const owner = (await createSpecialist(organizationId, { name: "Я", isPrincipal: true })).id;
    await createCommissionRule(organizationId, owner, {
      basisPoints: 4_000,
      activeFrom: CATALOGUE_FROM,
    });

    await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
    const mine = await withTenant(organizationId, async (tx) => {
      const result = await recordCompletedVisit(tx, {
        organizationId,
        actor: { userId, role: "owner" },
        serviceId,
        specialistId: owner,
        clientId: null,
        addOnIds: [],
        completedAt: new Date("2026-03-11T10:00:00.000Z"),
        actualDurationMinutes: 90,
        requestId: "test",
      });
      if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      return result;
    });

    const { pl } = await report("2026-03");

    expect(pl.contributionMarginMinor).toBe(72_000);
    expect(pl.principalLabourMinor).toBe(mine.snapshot.commissionMinor);
    expect(pl.principalLabourMinor).toBe(24_000);
    // 720 of margin plus the 240 that never left, and no rent to pay.
    expect(pl.operatingProfitMinor).toBe(96_000);
  });

  it("charges a purchase of materials to the month it was bought in", async () => {
    await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
    await record({ name: "Гель", category: "materials", amountMinor: 50_000, spentOn: "2026-03-02" });

    const { pl } = await report("2026-03");

    // No consumption carries this cost any more, so the ledger row is the only
    // place it reaches the profit — as plain overhead.
    expect(pl.overheadMinor).toBe(50_000);
    expect(pl.overheadByCategory).toMatchObject({ materials: 50_000 });
    expect(pl.operatingProfitMinor).toBe(36_000 - 50_000);
  });

  it("leaves a row in another currency out and says how many", async () => {
    await record({ name: "Аренда", category: "rent", amountMinor: 20_000, spentOn: "2026-03-01" });
    await record({
      name: "Подписка",
      category: "subscriptions",
      amountMinor: 3_000,
      spentOn: "2026-03-02",
      currency: "EUR",
    });

    const result = await report("2026-03");

    expect(result.pl.overheadMinor).toBe(20_000);
    expect(result.excludedRows).toBe(1);
  });

  describe("labour the month owes", () => {
    async function setLabour(options: {
      recipient: "owner" | "specialist";
      amountMinor: number;
      specialistId?: string;
      payrollTaxBasisPoints?: number;
    }) {
      await adminDb.insert(laborCostRules).values({
        organizationId,
        recipient: options.recipient,
        specialistId: options.recipient === "specialist" ? (options.specialistId ?? specialistId) : null,
        basis: "fixed_monthly",
        amountMinor: options.amountMinor,
        payrollTaxBasisPoints: options.payrollTaxBasisPoints ?? 0,
        activeFrom: CATALOGUE_FROM,
      });
    }

    /*
     * The mistake this stage is built to prevent, against real rows.
     *
     * A master on a salary takes 0% on a visit, so the snapshot charges nothing
     * for labour; the salary is subtracted once, by the month. If both ever
     * fired, the services would each look unprofitable while the month looked
     * fine — plausible numbers, wrong business.
     */
    it("charges a salaried master once, and not on the visit", async () => {
      await adminDb
        .update(specialists)
        .set({ isPrincipal: false })
        .where(eq(specialists.id, specialistId));
      // A rule of 0% is how a salaried arrangement is expressed; the visit is
      // still refused without any rule at all, which is the point.
      await adminDb.delete(laborCostRules);
      await createCommissionRule(organizationId, specialistId, {
        basisPoints: 0,
        activeFrom: new Date("2026-02-01T00:00:00.000Z"),
      });
      await setLabour({ recipient: "specialist", amountMinor: 500_00 });

      await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
      const { pl } = await report("2026-03");

      expect(pl.labourCostMinor).toBe(0);
      expect(pl.salariedLabourMinor).toBe(500_00);
      expect(pl.operatingProfitMinor).toBe(pl.contributionMarginMinor - 500_00);
    });

    /*
     * The anchor of the redesign, end to end.
     *
     * The owner's commission is added back because it stayed in the business;
     * their imputed wage is subtracted because the work still cost something.
     * Price the hour at exactly what was booked and the two cancel, leaving
     * margin less overhead. Any other answer means one of the lines is wrong.
     */
    it("cancels the add-back against an owner's wage set to what they booked", async () => {
      await adminDb
        .update(specialists)
        .set({ isPrincipal: true })
        .where(eq(specialists.id, specialistId));

      await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
      await closeVisit(new Date("2026-03-14T10:00:00.000Z"));
      await record({ name: "Аренда", category: "rent", amountMinor: 800_00, spentOn: "2026-03-01" });

      const booked = (await report("2026-03")).pl.principalLabourMinor;
      expect(booked).toBeGreaterThan(0);

      await setLabour({ recipient: "owner", amountMinor: booked });
      const { pl } = await report("2026-03");

      expect(pl.ownerWageMinor).toBe(booked);
      expect(pl.economicProfitMinor).toBe(pl.contributionMarginMinor - pl.overheadMinor);
    });

    it("leaves economic profit unstated until a wage is", async () => {
      await adminDb
        .update(specialists)
        .set({ isPrincipal: true })
        .where(eq(specialists.id, specialistId));
      await closeVisit(new Date("2026-03-10T10:00:00.000Z"));

      const { pl } = await report("2026-03");

      expect(pl.principalLabourMinor).toBeGreaterThan(0);
      expect(pl.ownerWageMinor).toBeNull();
      expect(pl.economicProfitMinor).toBeNull();
      // The operating profit is knowable without it, and is still reported.
      expect(pl.operatingProfitMinor).toBeGreaterThan(0);
    });

    it("keeps a superseded rule out of the month the new one covers", async () => {
      await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
      await adminDb.insert(laborCostRules).values([
        {
          organizationId,
          recipient: "owner",
          basis: "fixed_monthly",
          amountMinor: 100_00,
          activeFrom: CATALOGUE_FROM,
          activeTo: new Date("2026-02-28T00:00:00.000Z"),
        },
        {
          organizationId,
          recipient: "owner",
          basis: "fixed_monthly",
          amountMinor: 300_00,
          activeFrom: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);

      // March pays the March rule and only it — not both, and not the old one.
      expect((await report("2026-03")).pl.ownerWageMinor).toBe(300_00);
      expect((await report("2026-01")).pl.ownerWageMinor).toBe(100_00);
    });

    it("subtracts the reserve before calling anything withdrawable", async () => {
      await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
      await setLabour({ recipient: "owner", amountMinor: 100_00 });
      await adminDb
        .update(organizations)
        .set({ withdrawalReserveMinor: 50_00 })
        .where(eq(organizations.id, organizationId));

      const { pl, withdrawalReserveMinor } = await report("2026-03");

      expect(withdrawalReserveMinor).toBe(50_00);
      expect(pl.safeToWithdrawMinor).toBe(pl.economicProfitMinor! - 50_00);
    });

    it("reads the reserve of its own organization and not a neighbour's", async () => {
      const other = await createOrganization({ name: "Соседи" });
      await adminDb
        .update(organizations)
        .set({ withdrawalReserveMinor: 9_999_00 })
        .where(eq(organizations.id, other.id));

      const { withdrawalReserveMinor } = await report("2026-03");

      expect(withdrawalReserveMinor).toBe(0);
    });
  });

  /*
   * Section 4 of the plan in one assertion: `organization.type` chooses words.
   * `buildPeriodPL` cannot see it — it is not in the input — but the loader
   * could grow a branch on it one day, and this is what would notice.
   */
  it("reports identical figures whichever shape of business it is", async () => {
    await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
    await record({ name: "Аренда", category: "rent", amountMinor: 20_000, spentOn: "2026-03-01" });

    await adminDb.update(organizations).set({ type: "studio" }).where(eq(organizations.id, organizationId));
    const asStudio = await report("2026-03");

    await adminDb.update(organizations).set({ type: "solo" }).where(eq(organizations.id, organizationId));
    const asSolo = await report("2026-03");

    expect(asSolo.pl).toEqual(asStudio.pl);
  });

  it("answers for a month in which nothing happened", async () => {
    const { pl } = await report("2026-03");

    expect(pl.revenueMinor).toBe(0);
    expect(pl.operatingProfitMinor).toBe(0);
    expect(pl.operatingMarginBasisPoints).toBeNull();
    expect(pl.incompleteVisits).toBe(0);
  });

  /*
   * Capacity is the one part of the report that comes from neither the
   * snapshots nor the ledger, so it is the one part `domain/capacity.test.ts`
   * cannot check on its own: everything there takes rota rows as values, and
   * what only a database can answer is which rows a tenant is handed.
   */
  describe("capacity", () => {
    /** A weekly shift for one specialist at one location. */
    async function roster(
      options: {
        organizationId?: string;
        specialistId?: string;
        weekday?: number;
        startMinute?: number;
        endMinute?: number;
      } = {},
    ) {
      const org = options.organizationId ?? organizationId;
      const location = await createLocation(org);
      await adminDb.insert(scheduleRules).values({
        organizationId: org,
        specialistId: options.specialistId ?? specialistId,
        locationId: location.id,
        weekday: options.weekday ?? 1,
        startMinute: options.startMinute ?? 9 * 60,
        endMinute: options.endMinute ?? 18 * 60,
        effectiveFrom: "2025-01-01",
      });
    }

    it("turns the month's rota into practical capacity", async () => {
      await roster();

      const { capacity } = await report("2026-03");

      // Five Mondays in March 2026, nine hours each, three quarters sellable.
      expect(capacity.scheduledMinutes).toBe(5 * 9 * 60);
      expect(capacity.practicalCapacityBasisPoints).toBe(7500);
      expect(capacity.practicalMinutes).toBe(2_025);
    });

    it("does not count a neighbour's rota as its own capacity", async () => {
      await roster();

      const other = await createOrganization({ name: "Соседи" });
      const theirSpecialist = await createSpecialist(other.id);
      await roster({
        organizationId: other.id,
        specialistId: theirSpecialist.id,
        weekday: 2,
        startMinute: 0,
        endMinute: 1_440,
      });

      const { capacity } = await report("2026-03");

      expect(capacity.scheduledMinutes).toBe(5 * 9 * 60);
    });

    it("leaves out someone who no longer works here", async () => {
      await roster();
      const left = await createSpecialist(organizationId);
      await roster({ specialistId: left.id, weekday: 3 });

      const withBoth = (await report("2026-03")).capacity.scheduledMinutes;
      await adminDb
        .update(specialists)
        .set({ archivedAt: new Date("2026-02-01T00:00:00.000Z") })
        .where(eq(specialists.id, left.id));
      const afterLeaving = (await report("2026-03")).capacity.scheduledMinutes;

      expect(withBoth).toBe(9 * 9 * 60);
      // A chair that no longer exists is not idle capacity.
      expect(afterLeaving).toBe(5 * 9 * 60);
    });

    /*
     * The numerator counts hours worked, not hours costed. A visit whose margin
     * could not be computed still occupied the chair, and reporting the studio
     * as idle because of a gap in the data would be a figure about the data
     * dressed up as a figure about the business.
     */
    it("counts every closed visit's time towards utilization", async () => {
      await roster();
      await closeVisit(new Date("2026-03-04T10:00:00.000Z"));
      await closeVisit(new Date("2026-03-05T10:00:00.000Z"));

      const { pl, capacity } = await report("2026-03");

      expect(pl.incompleteVisits).toBe(0);
      expect(capacity.bookedMinutes).toBe(180);
      expect(capacity.utilizationBasisPoints).toBe(889);
    });

    it("says nothing about utilization when there is no rota", async () => {
      const { capacity } = await report("2026-03");

      expect(capacity.scheduledMinutes).toBe(0);
      expect(capacity.utilizationBasisPoints).toBeNull();
      expect(capacity.fixedCostRateMinorPerHour).toBeNull();
    });

    it("breaks even where fixed costs meet contribution", async () => {
      await closeVisit(new Date("2026-03-04T10:00:00.000Z"));
      await record({ name: "Аренда", category: "rent", amountMinor: 10_000_00, spentOn: "2026-03-01" });

      const { pl, capacity } = await report("2026-03");

      // Revenue 600, contribution 360 — the visit is the whole mix.
      expect(capacity.contributionBasisPoints).toBe(
        Math.round((pl.contributionMarginMinor / pl.revenueMinor) * 10_000),
      );
      // And the target it implies covers the rent exactly.
      const atBreakEven =
        (capacity.breakEvenRevenueMinor! * capacity.contributionBasisPoints!) / 10_000;
      expect(Math.round(atBreakEven)).toBe(pl.overheadMinor);
    });
  });

  /*
   * Where the money went, as opposed to where the profit went. What only a
   * database can check here is the split between the two statements: the same
   * ledger row has to land in exactly one of them.
   */
  describe("cash flow", () => {
    async function draw(amountMinor: number, occurredOn: string, currency: "MDL" | "EUR" = "MDL") {
      await adminDb.insert(ownerDraws).values({ organizationId, amountMinor, currency, occurredOn });
    }

    it("counts a wage paid out that the profit statement does not", async () => {
      await closeVisit(new Date("2026-03-04T10:00:00.000Z"));
      await record({ name: "Выплата", category: "payroll", amountMinor: 15_000, spentOn: "2026-03-31" });

      const { pl, cashFlow } = await report("2026-03");

      // The wage is `cash_only`, so it changes no profit line — the work was
      // already counted through the visit's commission...
      expect(pl.overheadMinor).toBe(0);
      expect(pl.cashOnlyMinor).toBe(15_000);
      // ...and it is reported on its own line here rather than in the total.
      expect(cashFlow.ledgerPayrollMinor).toBe(15_000);
    });

    it("leaves ledger payroll out of the cash and says how much", async () => {
      await closeVisit(new Date("2026-03-04T10:00:00.000Z"));
      await record({ name: "Выплата", category: "payroll", amountMinor: 24_000, spentOn: "2026-03-31" });

      const { cashFlow } = await report("2026-03");

      // The commission on the visit above is already the labour leaving the
      // account; counting the ledger row too would pay the master twice.
      expect(cashFlow.spentFromLedgerMinor).toBe(0);
      expect(cashFlow.ledgerPayrollMinor).toBe(24_000);
      expect(cashFlow.visitLabourMinor).toBe(24_000);
    });

    it("takes an owner draw out of the cash and out of no profit line", async () => {
      await closeVisit(new Date("2026-03-04T10:00:00.000Z"));
      const before = await report("2026-03");

      await draw(30_000, "2026-03-20");
      const after = await report("2026-03");

      expect(after.pl.operatingProfitMinor).toBe(before.pl.operatingProfitMinor);
      expect(after.cashFlow.ownerDrawsMinor).toBe(30_000);
      expect(after.cashFlow.netCashMinor).toBe(before.cashFlow.netCashMinor - 30_000);
    });

    it("counts a draw in the month it happened and no other", async () => {
      await draw(10_000, "2026-02-28");
      await draw(20_000, "2026-03-01");
      await draw(40_000, "2026-04-01");

      expect((await report("2026-02")).cashFlow.ownerDrawsMinor).toBe(10_000);
      expect((await report("2026-03")).cashFlow.ownerDrawsMinor).toBe(20_000);
      expect((await report("2026-04")).cashFlow.ownerDrawsMinor).toBe(40_000);
    });

    it("leaves a draw in another currency out of the total", async () => {
      await draw(10_000, "2026-03-05");
      await draw(99_000, "2026-03-06", "EUR");

      expect((await report("2026-03")).cashFlow.ownerDrawsMinor).toBe(10_000);
    });

    it("does not count a neighbour's draws", async () => {
      const other = await createOrganization({ name: "Соседи" });
      await adminDb
        .insert(ownerDraws)
        .values({ organizationId: other.id, amountMinor: 99_000, currency: "MDL", occurredOn: "2026-03-10" });

      expect((await report("2026-03")).cashFlow.ownerDrawsMinor).toBe(0);
    });

    it("explains the gap between the month's profit and its cash", async () => {
      await closeVisit(new Date("2026-03-04T10:00:00.000Z"));
      await record({ name: "Гель впрок", category: "materials", amountMinor: 50_000, spentOn: "2026-03-02" });
      await draw(10_000, "2026-03-20");

      const { pl, cashFlow } = await report("2026-03");

      expect(cashFlow.profitToCashGapMinor).toBe(pl.operatingProfitMinor - cashFlow.netCashMinor);
      // Stocking up and taking money out both leave the account lighter than
      // the profit says, so the month earned more than it banked.
      expect(cashFlow.profitToCashGapMinor).toBeGreaterThan(0);
    });
  });

  it("costs every closed visit of the month", async () => {
    await closeVisit(new Date("2026-03-10T10:00:00.000Z"));
    await closeVisit(new Date("2026-03-11T10:00:00.000Z"));

    const { pl } = await report("2026-03");

    expect(pl.revenueMinor).toBe(120_000);
    expect(pl.contributionMarginMinor).toBe(72_000);
    expect(pl.incompleteVisits).toBe(0);
    expect(pl.incompleteRevenueMinor).toBe(0);
    expect(pl.incompleteReasonCounts).toEqual({});
  });
});
