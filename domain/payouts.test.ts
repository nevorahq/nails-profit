import { describe, expect, test } from "vitest";

import { buildPayoutLedger, monthsBetween, payoutStartMonth, shiftMonth, type MasterAccrual } from "@/domain/payouts";

const anna = (commissionMinor: number, wageMinor = 0): MasterAccrual => ({
  specialistId: "anna",
  commissionMinor,
  wageMinor,
});

describe("months", () => {
  test("shift across a year and list a span inclusively", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthsBetween("2026-11", "2027-01")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  test("the balance starts the month before the first payout", () => {
    expect(payoutStartMonth([])).toBeNull();
    expect(
      payoutStartMonth([
        { specialistId: "anna", amountMinor: 1, paidOn: "2026-11-02" },
        { specialistId: "anna", amountMinor: 1, paidOn: "2026-10-05" },
      ]),
    ).toBe("2026-09");
  });
});

describe("buildPayoutLedger", () => {
  test("before any payout it states the month's earnings and no balance", () => {
    const ledger = buildPayoutLedger({ month: "2026-10", accruals: { "2026-10": [anna(240_00, 500_00)] }, payouts: [] });

    expect(ledger.tracking).toBe(false);
    expect(ledger.startMonth).toBeNull();
    expect(ledger.rows).toEqual([
      expect.objectContaining({ accruedMinor: 740_00, paidMinor: 0, openingMinor: 0 }),
    ]);
  });

  test("a payout on the 5th settles the month before it, with no overpayment", () => {
    const accruals = { "2026-09": [anna(1_000_00)], "2026-10": [anna(800_00)] };
    const payouts = [{ specialistId: "anna", amountMinor: 1_000_00, paidOn: "2026-10-05" }];

    const september = buildPayoutLedger({ month: "2026-09", accruals, payouts });
    expect(september.rows[0]).toMatchObject({ openingMinor: 0, accruedMinor: 1_000_00, paidMinor: 0, closingMinor: 1_000_00 });

    const october = buildPayoutLedger({ month: "2026-10", accruals, payouts });
    expect(october.tracking).toBe(true);
    expect(october.rows[0]).toMatchObject({
      openingMinor: 1_000_00,
      accruedMinor: 800_00,
      paidMinor: 1_000_00,
      closingMinor: 800_00,
    });
    expect(october.totals.closingMinor).toBe(800_00);
  });

  test("a month before the span reads as untracked, even after payouts began", () => {
    const ledger = buildPayoutLedger({
      month: "2026-08",
      accruals: { "2026-08": [anna(100_00)] },
      payouts: [{ specialistId: "anna", amountMinor: 1, paidOn: "2026-10-05" }],
    });
    expect(ledger.tracking).toBe(false);
    expect(ledger.rows[0].paidMinor).toBe(0);
  });

  test("paying more than was earned is carried as a negative balance, not hidden", () => {
    const ledger = buildPayoutLedger({
      month: "2026-10",
      accruals: { "2026-09": [anna(100_00)], "2026-10": [] },
      payouts: [{ specialistId: "anna", amountMinor: 300_00, paidOn: "2026-10-01" }],
    });
    expect(ledger.rows[0].closingMinor).toBe(-200_00);
  });

  test("a master owed from before stays on the list in a month they did not work", () => {
    const ledger = buildPayoutLedger({
      month: "2026-11",
      accruals: { "2026-09": [anna(500_00)], "2026-10": [], "2026-11": [] },
      payouts: [{ specialistId: "bob", amountMinor: 10_00, paidOn: "2026-10-01" }],
    });
    const owed = ledger.rows.find((row) => row.specialistId === "anna");
    expect(owed).toMatchObject({ openingMinor: 500_00, accruedMinor: 0, closingMinor: 500_00 });
  });

  test("somebody fully settled and idle drops off", () => {
    const ledger = buildPayoutLedger({
      month: "2026-11",
      accruals: { "2026-09": [anna(500_00)], "2026-10": [], "2026-11": [] },
      payouts: [{ specialistId: "anna", amountMinor: 500_00, paidOn: "2026-10-01" }],
    });
    expect(ledger.rows).toEqual([]);
  });

  test("a payout after the month on screen is not counted in it", () => {
    const ledger = buildPayoutLedger({
      month: "2026-10",
      accruals: { "2026-09": [anna(500_00)], "2026-10": [anna(100_00)] },
      payouts: [
        { specialistId: "anna", amountMinor: 500_00, paidOn: "2026-10-01" },
        { specialistId: "anna", amountMinor: 100_00, paidOn: "2026-11-03" },
      ],
    });
    expect(ledger.rows[0]).toMatchObject({ paidMinor: 500_00, closingMinor: 100_00 });
  });
});
