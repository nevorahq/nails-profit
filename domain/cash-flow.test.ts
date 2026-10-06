import { describe, expect, it } from "vitest";

import { buildCashFlow, type CashFlowInput } from "@/domain/cash-flow";
import { expenseClassOf } from "@/domain/expense-classes";
import type { ExpenseCategory } from "@/domain/expense-categories";
import type { ResolvedExpense } from "@/domain/expense-periods";

function spent(
  category: ExpenseCategory,
  amountMinor: number,
  id = `${category}-${amountMinor}`,
): ResolvedExpense {
  return {
    id,
    name: category,
    category,
    amountMinor,
    spentOn: "2026-03-05",
    isRecurring: false,
    recurringFrom: null,
    recurringTo: null,
    month: "2026-03",
    class: expenseClassOf(category),
  };
}

function flow(overrides: Partial<CashFlowInput> = {}): CashFlowInput {
  return {
    month: "2026-03",
    revenueMinor: 100_000_00,
    paymentCommissionMinor: 2_000_00,
    visitLabourMinor: 40_000_00,
    salariedLabourMinor: 0,
    expenses: [],
    ownerDrawsMinor: 0,
    operatingProfitMinor: 20_000_00,
    ...overrides,
  };
}

describe("buildCashFlow", () => {
  it("lands the takings net of the acquirer's cut", () => {
    const result = buildCashFlow(flow());

    // The fee never reaches the account, so it reduces the inflow rather than
    // appearing as a payment out of it.
    expect(result.settledMinor).toBe(98_000_00);
  });

  it("counts wages paid out, without counting the work twice", () => {
    const result = buildCashFlow(flow({ expenses: [spent("payroll", 15_000_00)] }));

    // The profit statement holds this row back — the work already reached it
    // through each visit's commission. Here the payment is the event, but it is
    // reported on its own line rather than added to the ledger's total.
    expect(expenseClassOf("payroll")).toBe("cash_only");
    expect(result.ledgerPayrollMinor).toBe(15_000_00);
    expect(result.spentFromLedgerMinor).toBe(0);
  });

  /*
   * The one exclusion, and the reason for it: the visit commissions and the
   * monthly salaries above are already the labour leaving the account.
   */
  it("leaves ledger payroll out and says how much it left out", () => {
    const result = buildCashFlow(flow({ expenses: [spent("payroll", 40_000_00)] }));

    expect(result.spentFromLedgerMinor).toBe(0);
    expect(result.ledgerPayrollMinor).toBe(40_000_00);
    expect(result.netCashMinor).toBe(98_000_00 - 40_000_00);
  });

  it("keeps payroll out of the category breakdown too", () => {
    const result = buildCashFlow(
      flow({ expenses: [spent("payroll", 40_000_00), spent("rent", 10_000_00)] }),
    );

    expect(result.spentByCategory).toEqual({ rent: 10_000_00 });
  });

  it("takes the owner's draw out of the cash and out of nothing else", () => {
    const withDraw = buildCashFlow(flow({ ownerDrawsMinor: 30_000_00 }));
    const without = buildCashFlow(flow());

    expect(withDraw.netCashMinor).toBe(without.netCashMinor - 30_000_00);
    // A draw is not a cost: the profit it is taken out of is unchanged.
    expect(withDraw.operatingProfitMinor).toBe(without.operatingProfitMinor);
  });

  it("subtracts a salary once, from the cash, alongside the visit commissions", () => {
    const result = buildCashFlow(flow({ salariedLabourMinor: 12_000_00 }));

    expect(result.netCashMinor).toBe(98_000_00 - 40_000_00 - 12_000_00);
  });

  /*
   * The line the statement exists for. Profit and cash disagree, and the report
   * has to be able to say by how much and in which direction.
   */
  it("explains the gap between profit and cash", () => {
    const stockingUp = buildCashFlow(
      flow({ expenses: [spent("materials", 25_000_00)], operatingProfitMinor: 20_000_00 }),
    );

    // Earned 200, banked 33: the difference is the crate and the draw-free month.
    expect(stockingUp.netCashMinor).toBe(33_000_00);
    expect(stockingUp.profitToCashGapMinor).toBe(20_000_00 - 33_000_00);
  });

  it("reports a negative month as negative rather than as zero", () => {
    const result = buildCashFlow(
      flow({ revenueMinor: 10_000_00, paymentCommissionMinor: 0, visitLabourMinor: 4_000_00, expenses: [spent("rent", 20_000_00)] }),
    );

    expect(result.netCashMinor).toBe(-14_000_00);
  });

  it("answers for a month in which nothing moved", () => {
    const result = buildCashFlow(
      flow({
        revenueMinor: 0,
        paymentCommissionMinor: 0,
        visitLabourMinor: 0,
        operatingProfitMinor: 0,
      }),
    );

    expect(result.settledMinor).toBe(0);
    expect(result.netCashMinor).toBe(0);
    expect(result.profitToCashGapMinor).toBe(0);
    expect(result.spentByCategory).toEqual({});
  });

  it("adds up to its own bottom line", () => {
    const result = buildCashFlow(
      flow({
        salariedLabourMinor: 12_000_00,
        ownerDrawsMinor: 30_000_00,
        expenses: [spent("rent", 10_000_00), spent("materials", 5_000_00), spent("payroll", 1_000_00)],
      }),
    );

    expect(result.netCashMinor).toBe(
      result.settledMinor -
        result.visitLabourMinor -
        result.salariedLabourMinor -
        result.spentFromLedgerMinor -
        result.ownerDrawsMinor,
    );
  });
});

describe("buildCashFlow with a rented chair", () => {
  it("takes the rent in beside the visits, outside the acquirer's cut", () => {
    const without = buildCashFlow(flow());
    const withRent = buildCashFlow(flow({ chairRentMinor: 3_000_00 }));

    expect(withRent.chairRentMinor).toBe(3_000_00);
    expect(withRent.settledMinor).toBe(without.settledMinor);
    expect(withRent.netCashMinor).toBe(without.netCashMinor + 3_000_00);
  });
});

describe("buildCashFlow once payouts are tracked", () => {
  it("swaps the hired masters' pay for what was handed over, and keeps the rest", () => {
    const accrual = buildCashFlow(flow({ salariedLabourMinor: 6_000_00 }));
    const fact = buildCashFlow(
      flow({
        salariedLabourMinor: 6_000_00,
        masterPayouts: { paidMinor: 25_000_00, owedMinor: 19_000_00, commissionMinor: 38_000_00, wageMinor: 5_000_00 },
      }),
    );

    // A principal's 2 000 of the 40 000 stays, as do the 1 000 of contributions.
    expect(fact.visitLabourMinor).toBe(2_000_00);
    expect(fact.salariedLabourMinor).toBe(1_000_00);
    expect(fact.masterPayoutsMinor).toBe(25_000_00);
    expect(fact.owedToMastersMinor).toBe(19_000_00);
    expect(fact.netCashMinor).toBe(accrual.netCashMinor + 38_000_00 + 5_000_00 - 25_000_00);
    // The profit it is set against does not move.
    expect(fact.operatingProfitMinor).toBe(accrual.operatingProfitMinor);
  });

  it("reads no payouts as untracked, with nothing owed stated", () => {
    const result = buildCashFlow(flow());
    expect(result.masterPayoutsMinor).toBeNull();
    expect(result.owedToMastersMinor).toBeNull();
  });
});

describe("buildCashFlow with tips", () => {
  it("takes tips in and hands a hired master's back out, leaving the cash as it was", () => {
    const without = buildCashFlow(flow());
    const result = buildCashFlow(flow({ tipsMinor: 5_000, tipsPaidOutMinor: 5_000 }));

    expect(result.tipsMinor).toBe(5_000);
    expect(result.tipsPaidOutMinor).toBe(5_000);
    expect(result.netCashMinor).toBe(without.netCashMinor);
    // The profit never saw them, so neither does the gap.
    expect(result.profitToCashGapMinor).toBe(without.profitToCashGapMinor);
  });

  it("keeps a principal's tips on the account", () => {
    const without = buildCashFlow(flow());
    const result = buildCashFlow(flow({ tipsMinor: 5_000, tipsPaidOutMinor: 1_000 }));

    expect(result.netCashMinor).toBe(without.netCashMinor + 4_000);
    // The account grew faster than the business earned, by exactly that.
    expect(result.profitToCashGapMinor).toBe(without.profitToCashGapMinor - 4_000);
  });

  it("reads absent tips as none", () => {
    const result = buildCashFlow(flow());
    expect(result.tipsMinor).toBe(0);
    expect(result.tipsPaidOutMinor).toBe(0);
  });
});
