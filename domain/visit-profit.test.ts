import { describe, expect, it } from "vitest";

import { calculateVisitProfit, type VisitProfitInput } from "@/domain/visit-profit";

function visit(overrides: Partial<VisitProfitInput> = {}): VisitProfitInput {
  return {
    currency: "MDL",
    lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0 }],
    commission: { type: "percentage", basisPoints: 4_000 },
    plannedDurationMinutes: 90,
    actualDurationMinutes: 90,
    ...overrides,
  };
}

describe("calculateVisitProfit", () => {
  it("costs a completed visit from its snapshots", () => {
    const result = calculateVisitProfit(visit());

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    // 600 revenue, 240 commission => 360 left.
    expect(result.revenueMinor).toBe(60_000);
    expect(result.costing).toMatchObject({
      commissionMinor: 24_000,
      contributionMarginMinor: 36_000,
    });
  });

  it("sums add-on lines into the revenue", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [
          { kind: "service", priceMinor: 60_000, discountMinor: 0 },
          { kind: "add_on", priceMinor: 10_000, discountMinor: 0 },
        ],
      }),
    );

    expect(result.revenueMinor).toBe(70_000);
  });

  it("subtracts a discount from the revenue the commission is taken on", () => {
    const result = calculateVisitProfit(
      visit({ lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 10_000 }] }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.revenueMinor).toBe(50_000);
    // The master's 40% is of what the client actually paid, not of the list price.
    expect(result.costing.commissionMinor).toBe(20_000);
  });

  it("falls back to the planned duration and marks the result an estimate", () => {
    // Section 8.8.1: a missing duration does not withhold the figure, it
    // flags it — the planned duration stands in and the result is an estimate.
    const result = calculateVisitProfit(visit({ actualDurationMinutes: null }));

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.estimatedDuration).toBe(true);
    expect(result.durationMinutes).toBe(90);
    expect(result.costing.profitPerHourMinor).toBe(24_000);
  });

  it("uses the actual duration when it was recorded", () => {
    const result = calculateVisitProfit(visit({ actualDurationMinutes: 120 }));

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.estimatedDuration).toBe(false);
    // The same 360 MDL earned over two hours instead of an hour and a half.
    expect(result.costing.profitPerHourMinor).toBe(18_000);
  });

  it("treats a visit with no revenue as incomplete rather than as a total loss", () => {
    const result = calculateVisitProfit(visit({ lines: [] }));

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("no_revenue");
  });

  it("reports a loss-making visit as a loss", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [{ kind: "service", priceMinor: 30_000, discountMinor: 0 }],
        commission: { type: "fixed", amountMinor: 40_000 },
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.contributionMarginMinor).toBeLessThan(0);
    expect(result.costing.profitPerHourMinor).toBeLessThan(0);
  });

  it("takes a refund out of revenue", () => {
    const result = calculateVisitProfit(
      visit({ lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0, refundMinor: 10_000 }] }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.revenueMinor).toBe(50_000);
    // The commission follows the revenue: the master is not paid on money the
    // client got back.
    expect(result.costing.commissionMinor).toBe(20_000);
  });

  it("leaves the acquirer's fee on the sum that was processed", () => {
    const refunded = calculateVisitProfit(
      visit({
        lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0, refundMinor: 60_000 }],
        payment: { basisPoints: 220, fixedFeeMinor: 0 },
      }),
    );

    expect(refunded.status).toBe("incomplete");
    if (refunded.status !== "incomplete") throw new Error("expected incomplete");
    // Fully refunded means no revenue at all, which the engine already refuses
    // to call a margin — the fee question is settled by the partial case below.
    expect(refunded.reasons).toContain("no_revenue");
  });

  it("charges the acquirer on what was taken, not on what was kept", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0, refundMinor: 20_000 }],
        payment: { basisPoints: 220, fixedFeeMinor: 0 },
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    // 2.2% of the 600 processed, not of the 400 kept: the bank does not return
    // its fee with the refund.
    expect(result.costing.paymentCommissionMinor).toBe(1_320);
  });

  it("passes the visit's tax snapshot through to the engine", () => {
    const result = calculateVisitProfit(
      visit({
        taxes: { vatBasisPoints: 2_000, remittableVat: true, turnoverBasisPoints: 0, payrollBasisPoints: 0 },
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.vatMinor).toBe(10_000);
    expect(result.costing.netRevenueMinor).toBe(50_000);
  });

  /*
   * The two questions the commission base answers, and the reason they are
   * answered here rather than in the engine: both need the lines.
   */
  it("pays on the sticker price when the rule says full_price", () => {
    const discounted = {
      kind: "service" as const,
      priceMinor: 60_000,
      discountMinor: 10_000,
      refundMinor: 0,
    };

    const onFullPrice = calculateVisitProfit(
      visit({ lines: [discounted], commissionBase: "full_price" }),
    );
    const onWhatWasPaid = calculateVisitProfit(visit({ lines: [discounted] }));

    expect(onFullPrice.status).toBe("complete");
    if (onFullPrice.status !== "complete") throw new Error("expected complete");
    expect(onWhatWasPaid.status).toBe("complete");
    if (onWhatWasPaid.status !== "complete") throw new Error("expected complete");

    // 40% of 600 against 40% of 500. The discount was the studio's decision,
    // and whether the master shares in it is exactly what this setting says.
    expect(onFullPrice.costing.commissionMinor).toBe(24_000);
    expect(onWhatWasPaid.costing.commissionMinor).toBe(20_000);
    // Either way the visit took 500: the base moves the master's share, not the
    // revenue.
    expect(onFullPrice.revenueMinor).toBe(50_000);
    expect(onWhatWasPaid.revenueMinor).toBe(50_000);
  });

  it("pays only on the lines the rule covers", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [
          { kind: "service", priceMinor: 60_000, discountMinor: 0 },
          { kind: "add_on", priceMinor: 20_000, discountMinor: 0, commissionable: false },
        ],
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    // The whole 800 is revenue; only the 600 the rule covers pays a commission.
    expect(result.revenueMinor).toBe(80_000);
    expect(result.costing.commissionMinor).toBe(24_000);
  });

  it("keeps a refund out of the base it was taken out of", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0, refundMinor: 10_000 }],
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.commissionMinor).toBe(20_000);
  });

  it("still pays on the sticker price after a refund when the rule says so", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0, refundMinor: 10_000 }],
        commissionBase: "full_price",
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    // A studio that promised the sticker price promised it before the client
    // asked for money back. Whether that is wise is the studio's call; the
    // product records the deal it was told about.
    expect(result.costing.commissionMinor).toBe(24_000);
  });

  it("pays a hybrid its guarantee even when every line is excluded", () => {
    const result = calculateVisitProfit(
      visit({
        lines: [{ kind: "service", priceMinor: 60_000, discountMinor: 0, commissionable: false }],
        commission: { type: "hybrid", amountMinor: 5_000, basisPoints: 4_000 },
      }),
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.commissionMinor).toBe(5_000);
  });
});
