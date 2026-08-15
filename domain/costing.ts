import { roundRatio, type Currency } from "@/domain/money";

/**
 * Section 8.8.1 commission forms. The database enum derives from this list.
 *
 * `hybrid` is a guaranteed amount per visit plus a share of the takings — the
 * arrangement a studio offers a master it wants to keep through a quiet month.
 * Adding it is the one place in the redesign where a working integrity rule had
 * to be rewritten rather than extended, which is why it waited until last.
 */
export const commissionTypes = [
  "percentage",
  "fixed",
  "percentage_after_materials",
  "hybrid",
] as const;
export type CommissionType = (typeof commissionTypes)[number];

export type Commission =
  | { type: "percentage"; basisPoints: number }
  | { type: "fixed"; amountMinor: number }
  | { type: "percentage_after_materials"; basisPoints: number }
  | { type: "hybrid"; basisPoints: number; amountMinor: number };

/**
 * The formula this code implements today.
 *
 * Stamped into every snapshot it writes, so that a later change of formula can
 * be told apart from a figure computed under the old one. Snapshots already in
 * the database keep the version they were written with and are never
 * recomputed — that is the whole point of storing it, and the reason this is a
 * constant rather than a literal repeated at each call site.
 */
export const CURRENT_FORMULA_VERSION = "costing-v2";
export type FormulaVersion = typeof CURRENT_FORMULA_VERSION;

/**
 * The tax rates in force for one visit, snapshotted into it when it closed.
 *
 * Stored on `visit.tax_snapshot` in exactly this shape. One shape rather than a
 * wire form and a domain form: the column is read by this file and written by
 * `lib/visit-service.ts`, and a mapping layer between two spellings of the same
 * four numbers would be somewhere for them to drift apart.
 */
export type TaxRates = Readonly<{
  /** Prices are VAT-inclusive, so this is extracted from the price, not added. */
  vatBasisPoints: number;
  /** False records the rate without taking it out of revenue. */
  remittableVat: boolean;
  /** Tax on turnover, charged on revenue net of any remitted VAT. */
  turnoverBasisPoints: number;
  /** Employer's contributions on the master's commission for this visit. */
  payrollBasisPoints: number;
}>;

export const NO_TAXES: TaxRates = {
  vatBasisPoints: 0,
  remittableVat: false,
  turnoverBasisPoints: 0,
  payrollBasisPoints: 0,
};

/** What the acquirer took, and the amount it took it from. */
export type PaymentCost = Readonly<{
  basisPoints: number;
  fixedFeeMinor: number;
  /**
   * The sum the terminal actually processed — before refunds.
   *
   * A refund does not usually return the acquirer's fee, so charging it on the
   * amount kept would understate the cost. Of the two directions to be wrong
   * in, this product does not take the flattering one.
   */
  chargedMinor: number;
}>;

/**
 * What a percentage commission is a percentage *of*.
 *
 * Two values, not the four v1 of the plan listed, because two of those four are
 * already in the model and would have become a second way to say the same
 * thing. «After materials» is a commission *type*
 * (`percentage_after_materials`), and «only these services» is a filter over
 * the visit's lines rather than a different arithmetic — see
 * `domain/visit-profit.ts`, which applies it. What is left is the one question
 * the model could not answer: whether the master is paid on the sticker price
 * or on what the client actually paid after a discount.
 */
export const commissionBases = ["full_price", "after_discount"] as const;
export type CommissionBase = (typeof commissionBases)[number];

export type CostingInput = Readonly<{
  priceMinor: number;
  materialCostMinor: number | null;
  durationMinutes: number;
  currency: Currency;
  commission: Commission;
  /**
   * The sum the percentage applies to, when it is not the revenue.
   *
   * Computed by the caller, because choosing it needs the visit's lines — which
   * were discounted, which were refunded, and which services the rule covers —
   * and this engine has only ever taken one revenue figure. Omitted means the
   * revenue itself, which is what every rule written before this did.
   */
  commissionBaseMinor?: number;
  /**
   * Both optional, and both absent from a service costing on purpose: a service
   * in the catalogue has no payment method and no VAT to hand over, because
   * nobody has paid for it yet. Omitted means zero everywhere below, which is
   * what makes `costing-v2` reproduce every `costing-v1` figure exactly.
   */
  payment?: PaymentCost;
  taxes?: TaxRates;
}>;

/** Why a costing could not be completed. Drives the CST-010 list. */
export type IncompleteReason = "missing_material_cost";

type CostingCommon = {
  formulaVersion: FormulaVersion;
  currency: Currency;
  priceMinor: number;
  durationMinutes: number;
  explanation: readonly string[];
};

/**
 * Spec section 8.8.1: a missing material cost is never treated as zero. Rather
 * than throwing, the calculation returns `incompleteCostData` so the visit can
 * still be stored and listed (CST-010). The incomplete branch carries no
 * figures at all — a partial number here would be read as a real margin.
 */
export type CostingResult = Readonly<
  | (CostingCommon & {
      incompleteCostData: false;
      materialCostMinor: number;
      commissionMinor: number;
      /**
       * Revenue once the state's share is out of it: the price less any VAT
       * that is handed on. Equal to the price when there is no remitted VAT,
       * which is every visit closed before this existed.
       */
      netRevenueMinor: number;
      vatMinor: number;
      turnoverTaxMinor: number;
      paymentCommissionMinor: number;
      payrollTaxMinor: number;
      contributionMarginMinor: number;
      /**
       * Margin over net revenue, not over the price.
       *
       * Money handed to the state was never the studio's to keep, and counting
       * it in the denominator would report a lower margin for the same work
       * simply because VAT applies. With no VAT the two denominators are the
       * same number, so nothing already reported moves.
       */
      marginBasisPoints: number | null;
      profitPerHourMinor: number;
    })
  | (CostingCommon & {
      incompleteCostData: true;
      incompleteReasons: readonly IncompleteReason[];
    })
>;

function assertNonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

export function calculateCosting(input: CostingInput): CostingResult {
  assertNonNegativeInteger(input.priceMinor, "priceMinor");
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new RangeError("durationMinutes must be a positive integer");
  }

  if (input.materialCostMinor === null) {
    return {
      formulaVersion: CURRENT_FORMULA_VERSION,
      currency: input.currency,
      priceMinor: input.priceMinor,
      durationMinutes: input.durationMinutes,
      incompleteCostData: true,
      incompleteReasons: ["missing_material_cost"],
      explanation: [`price:${input.priceMinor}`, "materials:unknown", `duration_minutes:${input.durationMinutes}`],
    };
  }

  assertNonNegativeInteger(input.materialCostMinor, "materialCostMinor");

  // The revenue, unless the caller worked out a narrower base from the lines.
  const percentageBase = input.commissionBaseMinor ?? input.priceMinor;
  assertNonNegativeInteger(percentageBase, "commissionBaseMinor");

  let commissionMinor: number;
  switch (input.commission.type) {
    case "percentage":
      assertNonNegativeInteger(input.commission.basisPoints, "commission.basisPoints");
      commissionMinor = roundRatio(percentageBase * input.commission.basisPoints, 10_000);
      break;
    case "fixed":
      assertNonNegativeInteger(input.commission.amountMinor, "commission.amountMinor");
      commissionMinor = input.commission.amountMinor;
      break;
    case "percentage_after_materials": {
      assertNonNegativeInteger(input.commission.basisPoints, "commission.basisPoints");
      // Materials come off the whole visit's cost even when the percentage
      // applies to part of it: the master used the whole bottle either way.
      const afterMaterials = Math.max(0, percentageBase - input.materialCostMinor);
      commissionMinor = roundRatio(afterMaterials * input.commission.basisPoints, 10_000);
      break;
    }
    case "hybrid": {
      /*
       * A guaranteed amount plus a share. The two parts are added, never
       * compared: this is not «больше из двух», which is a different deal and
       * would have to be a different type rather than a silent reading of this
       * one.
       */
      assertNonNegativeInteger(input.commission.basisPoints, "commission.basisPoints");
      assertNonNegativeInteger(input.commission.amountMinor, "commission.amountMinor");
      commissionMinor =
        input.commission.amountMinor +
        roundRatio(percentageBase * input.commission.basisPoints, 10_000);
      break;
    }
  }

  /*
   * The commission above is taken on the price the client paid, VAT and all,
   * and stays there. That is what the master's contract says — «40% от чека» —
   * and moving the base to net revenue would quietly re-cut every arrangement
   * in the studio the day a VAT rate was entered. It is also what makes a
   * `costing-v2` recomputation of an old visit land on the old figure.
   */
  const taxes = input.taxes ?? NO_TAXES;
  assertNonNegativeInteger(taxes.vatBasisPoints, "taxes.vatBasisPoints");
  assertNonNegativeInteger(taxes.turnoverBasisPoints, "taxes.turnoverBasisPoints");
  assertNonNegativeInteger(taxes.payrollBasisPoints, "taxes.payrollBasisPoints");

  /*
   * VAT is taken *out of* the price, not added to it.
   *
   * A salon quotes one number and the client pays it; the tax was always inside
   * it. Adding 20% on top would invent revenue nobody was charged, so the
   * extraction is `price × rate / (1 + rate)` in basis points.
   *
   * A rate that is recorded but not remitted takes nothing out: the studio
   * keeps the money, and subtracting it would understate every visit.
   */
  const vatMinor =
    taxes.remittableVat && taxes.vatBasisPoints > 0
      ? roundRatio(input.priceMinor * taxes.vatBasisPoints, 10_000 + taxes.vatBasisPoints)
      : 0;
  const netRevenueMinor = input.priceMinor - vatMinor;

  // On revenue net of any VAT handed on — turnover is what the business took,
  // and the state's share was never that. In practice a business is on one
  // regime or the other, so the two rarely meet.
  const turnoverTaxMinor =
    taxes.turnoverBasisPoints > 0 ? roundRatio(netRevenueMinor * taxes.turnoverBasisPoints, 10_000) : 0;

  // Employer's contributions on this visit's commission. The monthly rule in
  // `domain/labor-cost.ts` charges the same thing on a salary; the two never
  // meet, because a salaried master's commission rate is zero (plan, 5.3).
  const payrollTaxMinor =
    taxes.payrollBasisPoints > 0 ? roundRatio(commissionMinor * taxes.payrollBasisPoints, 10_000) : 0;

  const payment = input.payment;
  if (payment) {
    assertNonNegativeInteger(payment.basisPoints, "payment.basisPoints");
    assertNonNegativeInteger(payment.fixedFeeMinor, "payment.fixedFeeMinor");
    assertNonNegativeInteger(payment.chargedMinor, "payment.chargedMinor");
  }
  // Nothing processed, nothing charged: the flat fee is per transaction, and a
  // visit that took no money had none.
  const paymentCommissionMinor =
    payment === undefined || payment.chargedMinor <= 0
      ? 0
      : roundRatio(payment.chargedMinor * payment.basisPoints, 10_000) + payment.fixedFeeMinor;

  const contributionMarginMinor =
    netRevenueMinor -
    input.materialCostMinor -
    commissionMinor -
    payrollTaxMinor -
    paymentCommissionMinor -
    turnoverTaxMinor;
  // A loss-making service must report its loss. Clamping these to zero would
  // contradict contributionMarginMinor and hide exactly what the product exists
  // to reveal. Margin percentage is undefined — not zero — for a free service.
  const marginBasisPoints =
    netRevenueMinor === 0 ? null : roundRatio(contributionMarginMinor * 10_000, netRevenueMinor);
  const profitPerHourMinor = roundRatio(contributionMarginMinor * 60, input.durationMinutes);

  return {
    formulaVersion: CURRENT_FORMULA_VERSION,
    currency: input.currency,
    priceMinor: input.priceMinor,
    durationMinutes: input.durationMinutes,
    incompleteCostData: false,
    materialCostMinor: input.materialCostMinor,
    commissionMinor,
    netRevenueMinor,
    vatMinor,
    turnoverTaxMinor,
    paymentCommissionMinor,
    payrollTaxMinor,
    contributionMarginMinor,
    marginBasisPoints,
    profitPerHourMinor,
    explanation: [
      `price:${input.priceMinor}`,
      ...(vatMinor > 0 ? [`vat:${vatMinor}`] : []),
      `materials:${input.materialCostMinor}`,
      `commission:${commissionMinor}`,
      ...(payrollTaxMinor > 0 ? [`payroll_tax:${payrollTaxMinor}`] : []),
      ...(paymentCommissionMinor > 0 ? [`payment_commission:${paymentCommissionMinor}`] : []),
      ...(turnoverTaxMinor > 0 ? [`turnover_tax:${turnoverTaxMinor}`] : []),
      `duration_minutes:${input.durationMinutes}`,
    ],
  };
}
