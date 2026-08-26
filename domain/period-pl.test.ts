import { describe, expect, it } from "vitest";

import { aggregateVisitMetrics, type VisitMetricRow } from "@/domain/dashboard-metrics";
import { expensesForMonth, type PeriodExpenseRow } from "@/domain/expense-periods";
import { selectLaborRules, type LaborCostRuleRow } from "@/domain/labor-cost";
import { buildPeriodPL } from "@/domain/period-pl";

/*
 * The canonical studio, one visit at a time: 600 charged, 40% commission —
 * margin 360. Six of them make a month worth reporting.
 */
function visit(overrides: Partial<VisitMetricRow> & { visitId: string }): VisitMetricRow {
  return {
    serviceId: "service-a",
    serviceName: "Маникюр",
    revenueMinor: 600_00,
    commissionMinor: 240_00,
    contributionMarginMinor: 360_00,
    vatMinor: null,
    turnoverTaxMinor: null,
    payrollTaxMinor: null,
    paymentCommissionMinor: null,
    durationMinutes: 90,
    workedMinutes: 90,
    incompleteReasons: [],
    completedAt: new Date("2026-03-12T10:00:00.000Z"),
    masterIsPrincipal: false,
    ...overrides,
  };
}

function expense(overrides: Partial<PeriodExpenseRow> & { id: string }): PeriodExpenseRow {
  return {
    name: "Аренда",
    category: "rent",
    amountMinor: 800_00,
    spentOn: "2026-03-05",
    isRecurring: false,
    recurringFrom: null,
    recurringTo: null,
    ...overrides,
  };
}

function labor(overrides: Partial<LaborCostRuleRow> & { id: string }): LaborCostRuleRow {
  return {
    recipient: "specialist",
    specialistId: "master-a",
    label: "Оклад",
    basis: "fixed_monthly",
    amountMinor: 500_00,
    basisPoints: null,
    payrollTaxBasisPoints: 0,
    activeFrom: new Date("2026-01-01T00:00:00.000Z"),
    activeTo: null,
    ...overrides,
  };
}

function pl(
  rows: VisitMetricRow[],
  ledger: PeriodExpenseRow[],
  options: { labor?: LaborCostRuleRow[]; reserveMinor?: number; month?: string } = {},
) {
  const month = options.month ?? "2026-03";
  return buildPeriodPL({
    month,
    metrics: aggregateVisitMetrics(rows),
    expenses: expensesForMonth(ledger, month),
    laborRules: selectLaborRules(options.labor ?? [], month),
    withdrawalReserveMinor: options.reserveMinor,
  });
}

describe("buildPeriodPL", () => {
  it("subtracts the overhead from the margin and nothing else", () => {
    const report = pl(
      [visit({ visitId: "1" }), visit({ visitId: "2" }), visit({ visitId: "3" })],
      [expense({ id: "rent" })],
    );

    expect(report.revenueMinor).toBe(1_800_00);
    expect(report.labourCostMinor).toBe(720_00);
    expect(report.contributionMarginMinor).toBe(1_080_00);
    expect(report.overheadMinor).toBe(800_00);
    expect(report.operatingProfitMinor).toBe(280_00);
  });

  /*
   * The defect this whole stage exists to close. A wage paid out is money
   * leaving the account, and it is already counted through each visit's
   * commission. Subtracting it again would charge the month twice.
   *
   * A crate of gel used to be held back the same way, because the visits that
   * consumed it carried its cost. Nothing carries it now, so it is ordinary
   * overhead and does come out of the profit — see `domain/expense-classes.ts`.
   */
  it("does not subtract what a visit already counted", () => {
    const visits = [visit({ visitId: "1" }), visit({ visitId: "2" }), visit({ visitId: "3" })];
    const withoutLedgerNoise = pl(visits, [expense({ id: "rent" })]);
    const withLedgerNoise = pl(visits, [
      expense({ id: "rent" }),
      expense({ id: "wage", category: "payroll", amountMinor: 720_00 }),
    ]);

    expect(withLedgerNoise.operatingProfitMinor).toBe(withoutLedgerNoise.operatingProfitMinor);
    // Shown all the same — 720 left the account and the report says so.
    expect(withLedgerNoise.cashOnlyMinor).toBe(720_00);
    expect(withLedgerNoise.cashOnlyByCategory).toEqual({ payroll: 720_00 });
  });

  it("subtracts a crate of gel from the month it was bought in", () => {
    const visits = [visit({ visitId: "1" })];
    const without = pl(visits, [expense({ id: "rent" })]);
    const withGel = pl(visits, [
      expense({ id: "rent" }),
      expense({ id: "gel", category: "materials", amountMinor: 500_00 }),
    ]);

    expect(withGel.operatingProfitMinor).toBe(without.operatingProfitMinor - 500_00);
    expect(withGel.overheadByCategory).toMatchObject({ materials: 500_00 });
  });

  describe("the owner who also works", () => {
    it("adds their commission back, because it never left the business", () => {
      const hired = pl([visit({ visitId: "1" }), visit({ visitId: "2" })], [expense({ id: "rent" })]);
      const owner = pl(
        [visit({ visitId: "1", masterIsPrincipal: true }), visit({ visitId: "2", masterIsPrincipal: true })],
        [expense({ id: "rent" })],
      );

      // The margin is identical — the visit costs the same either way, which is
      // what makes the two services comparable.
      expect(owner.contributionMarginMinor).toBe(hired.contributionMarginMinor);
      // The month is not. 480 of commission stayed in the business.
      expect(owner.principalLabourMinor).toBe(480_00);
      expect(owner.operatingProfitMinor).toBe(hired.operatingProfitMinor + 480_00);
    });

    it("adds back only the principal's share of a mixed month", () => {
      const report = pl(
        [
          visit({ visitId: "owner", masterIsPrincipal: true }),
          visit({ visitId: "hired-1" }),
          visit({ visitId: "hired-2", masterIsPrincipal: null }),
        ],
        [],
      );

      expect(report.labourCostMinor).toBe(720_00);
      expect(report.principalLabourMinor).toBe(240_00);
    });

    /*
     * Visits closed before the question existed carry null, and null is read as
     * "not a principal" — never as one. Adding back a commission that did leave
     * the business would invent profit.
     */
    it("reads an unanswered visit as not a principal", () => {
      const report = pl([visit({ visitId: "1", masterIsPrincipal: null })], []);

      expect(report.principalLabourMinor).toBe(0);
    });

    it("leaves the owner-administrator's add-back at zero", () => {
      // Nobody principal took a visit; their wage is a stage-4 line, not this one.
      const report = pl([visit({ visitId: "1" })], [expense({ id: "rent" })]);

      expect(report.principalLabourMinor).toBe(0);
      expect(report.operatingProfitMinor).toBe(360_00 - 800_00);
    });
  });

  describe("months that do not add up", () => {
    it("reports a loss as a loss", () => {
      const report = pl([visit({ visitId: "1" })], [expense({ id: "rent", amountMinor: 5_000_00 })]);

      expect(report.operatingProfitMinor).toBe(360_00 - 5_000_00);
      expect(report.operatingMarginBasisPoints).toBeLessThan(0);
    });

    it("has no margin to state for a month with no revenue", () => {
      const report = pl([], [expense({ id: "rent" })]);

      expect(report.revenueMinor).toBe(0);
      expect(report.operatingProfitMinor).toBe(-800_00);
      // Not zero: a ratio without a denominator is not a ratio.
      expect(report.operatingMarginBasisPoints).toBeNull();
    });

    it("survives a month with no ledger at all", () => {
      const report = pl([visit({ visitId: "1" })], []);

      expect(report.overheadMinor).toBe(0);
      expect(report.overheadByCategory).toEqual({});
      expect(report.operatingProfitMinor).toBe(360_00);
    });

    /*
     * An uncosted visit brings its revenue and no margin, so the profit it
     * implies is missing while the overhead it shares is not. The figure is a
     * floor, and the count beside it is what says so.
     */
    it("carries the uncosted visits forward instead of averaging them away", () => {
      const report = pl(
        [
          visit({ visitId: "costed" }),
          visit({
            visitId: "uncosted",
            contributionMarginMinor: null,
            commissionMinor: null,
            incompleteReasons: ["no_revenue"],
          }),
        ],
        [],
      );

      expect(report.revenueMinor).toBe(1_200_00);
      expect(report.contributionMarginMinor).toBe(360_00);
      expect(report.incompleteVisits).toBe(1);
      expect(report.incompleteRevenueMinor).toBe(600_00);
      expect(report.incompleteReasonCounts).toEqual({ no_revenue: 1 });
    });
  });

  describe("labour the month owes and no visit does", () => {
    /*
     * The one that costs a business its numbers. A master on a salary takes no
     * commission on a visit — their rule is 0%, so the snapshot charges nothing
     * — and the salary comes out once, here. Charge it in both places and every
     * service looks unprofitable while the month looks fine.
     */
    it("charges a salary once, at the level of the month", () => {
      const salaried = [
        visit({ visitId: "1", commissionMinor: 0, contributionMarginMinor: 580_00 }),
        visit({ visitId: "2", commissionMinor: 0, contributionMarginMinor: 580_00 }),
      ];
      const report = pl(salaried, [], { labor: [labor({ id: "salary", amountMinor: 500_00 })] });

      // The visits charged nothing for labour…
      expect(report.labourCostMinor).toBe(0);
      // …and the month charged it exactly once.
      expect(report.salariedLabourMinor).toBe(500_00);
      expect(report.operatingProfitMinor).toBe(1_160_00 - 500_00);
    });

    it("counts the employer's contributions as part of the wage", () => {
      const report = pl([visit({ visitId: "1" })], [], {
        labor: [labor({ id: "salary", amountMinor: 500_00, payrollTaxBasisPoints: 2_400 })],
      });

      expect(report.salariedLabourMinor).toBe(620_00);
    });

    it("adds up several people and leaves the owner out of that line", () => {
      const report = pl([visit({ visitId: "1" })], [], {
        labor: [
          labor({ id: "a", specialistId: "master-a", amountMinor: 500_00 }),
          labor({ id: "b", specialistId: "master-b", amountMinor: 300_00 }),
          labor({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 900_00 }),
        ],
      });

      expect(report.salariedLabourMinor).toBe(800_00);
      expect(report.ownerWageMinor).toBe(900_00);
    });
  });

  describe("economic profit", () => {
    /*
     * The anchor of the whole redesign.
     *
     * The owner's commission is added back because it never left the business;
     * what their work is worth is subtracted because it is a real cost. Set the
     * second equal to the first — «мой час стоит ровно рыночную ставку» — and
     * the two cancel, leaving margin less overhead and nothing else. Any other
     * result means one of the two lines is wrong.
     */
    it("cancels exactly when the owner's wage equals the commissions they booked", () => {
      const visits = [
        visit({ visitId: "1", masterIsPrincipal: true }),
        visit({ visitId: "2", masterIsPrincipal: true }),
      ];
      const report = pl(visits, [expense({ id: "rent", amountMinor: 800_00 })], {
        // Two visits at 240 of commission each.
        labor: [labor({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 480_00 })],
      });

      expect(report.principalLabourMinor).toBe(480_00);
      expect(report.ownerWageMinor).toBe(480_00);
      expect(report.economicProfitMinor).toBe(report.contributionMarginMinor - report.overheadMinor);
      expect(report.economicProfitMinor).toBe(720_00 - 800_00);
    });

    it("shows the gap when the owner prices their hour above the market", () => {
      const visits = [visit({ visitId: "1", masterIsPrincipal: true })];
      const report = pl(visits, [], {
        labor: [labor({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 600_00 })],
      });

      // Booked 240, values the work at 600: the business is 360 short of paying
      // for the owner's own time, and the number says so rather than hiding it.
      expect(report.operatingProfitMinor).toBe(360_00 + 240_00);
      expect(report.economicProfitMinor).toBe(600_00 - 600_00);
    });

    /*
     * An owner who only runs the place takes no visits, so nothing is added
     * back — and the same rule, the same code path, still subtracts their wage.
     * One mechanism for both, which is why `recipient = 'admin'` was dropped.
     */
    it("handles the owner who never takes a visit through the same rule", () => {
      const report = pl([visit({ visitId: "1" })], [], {
        labor: [labor({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 900_00 })],
      });

      expect(report.principalLabourMinor).toBe(0);
      expect(report.operatingProfitMinor).toBe(360_00);
      expect(report.economicProfitMinor).toBe(360_00 - 900_00);
    });

    it("says nothing rather than zero when no wage was ever stated", () => {
      const report = pl([visit({ visitId: "1", masterIsPrincipal: true })], []);

      expect(report.ownerWageMinor).toBeNull();
      expect(report.economicProfitMinor).toBeNull();
      expect(report.safeToWithdrawMinor).toBeNull();
      // The operating profit is still knowable and still shown.
      expect(report.operatingProfitMinor).toBe(600_00);
    });

    it("takes a share of the revenue when that is how the owner pays themselves", () => {
      const report = pl([visit({ visitId: "1" }), visit({ visitId: "2" })], [], {
        labor: [
          labor({
            id: "owner",
            recipient: "owner",
            specialistId: null,
            basis: "percent_revenue",
            amountMinor: null,
            basisPoints: 3_000,
          }),
        ],
      });

      expect(report.ownerWageMinor).toBe(360_00);
    });
  });

  describe("what is safe to take out", () => {
    it("holds back the reserve the owner chose", () => {
      const report = pl([visit({ visitId: "1" }), visit({ visitId: "2" })], [], {
        labor: [labor({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 200_00 })],
        reserveMinor: 300_00,
      });

      expect(report.economicProfitMinor).toBe(720_00 - 200_00);
      expect(report.safeToWithdrawMinor).toBe(520_00 - 300_00);
    });

    it("never invites a withdrawal out of a losing month", () => {
      const report = pl([visit({ visitId: "1" })], [expense({ id: "rent", amountMinor: 5_000_00 })], {
        labor: [labor({ id: "owner", recipient: "owner", specialistId: null, amountMinor: 900_00 })],
        reserveMinor: 0,
      });

      expect(report.economicProfitMinor).toBeLessThan(0);
      expect(report.safeToWithdrawMinor).toBe(0);
    });
  });

  it("leaves every stage-2 figure alone when no labour rule exists", () => {
    // The extension has to be an extension: a studio that never opens the new
    // settings page must read exactly the numbers it read yesterday.
    const rows = [visit({ visitId: "1" }), visit({ visitId: "2" })];
    const ledger = [expense({ id: "rent" })];

    expect(pl(rows, ledger).operatingProfitMinor).toBe(
      buildPeriodPL({
        month: "2026-03",
        metrics: aggregateVisitMetrics(rows),
        expenses: expensesForMonth(ledger, "2026-03"),
      }).operatingProfitMinor,
    );
  });

  it("states the margin against every rouble taken, not only the costed ones", () => {
    const report = pl(
      [
        visit({ visitId: "1" }),
        visit({
          visitId: "2",
          contributionMarginMinor: null,
          commissionMinor: null,
          incompleteReasons: ["no_revenue"],
        }),
      ],
      [expense({ id: "rent", amountMinor: 100_00 })],
    );

    // 360 − 100 = 260 over 1200 taken in, not over the 600 that could be costed.
    expect(report.operatingProfitMinor).toBe(260_00);
    expect(report.operatingMarginBasisPoints).toBe(2_167);
  });
});
