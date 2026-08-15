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
    class: expenseClassOf[category],
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

  it("counts a purchase of materials, and not their consumption", () => {
    const result = buildCashFlow(flow({ expenses: [spent("materials", 15_000_00)] }));

    // In the profit statement this row is `cash_only` and subtracts nothing.
    // Here it is the whole point: the crate was paid for this month.
    expect(expenseClassOf.materials).toBe("cash_only");
    expect(result.spentFromLedgerMinor).toBe(15_000_00);
    expect(result.netCashMinor).toBe(98_000_00 - 40_000_00 - 15_000_00);
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
