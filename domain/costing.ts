import { roundRatio, type Currency } from "@/domain/money";

export type Commission =
  | { type: "percentage"; basisPoints: number }
  | { type: "fixed"; amountMinor: number }
  | { type: "percentage_after_materials"; basisPoints: number };

export type CostingInput = Readonly<{
  priceMinor: number;
  materialCostMinor: number | null;
  durationMinutes: number;
  currency: Currency;
  commission: Commission;
}>;

/** Why a costing could not be completed. Drives the CST-010 list. */
export type IncompleteReason = "missing_material_cost";

type CostingCommon = {
  formulaVersion: "costing-v1";
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
      contributionMarginMinor: number;
      /** Null when the price is zero, where a margin percentage has no meaning. */
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
      formulaVersion: "costing-v1",
      currency: input.currency,
      priceMinor: input.priceMinor,
      durationMinutes: input.durationMinutes,
      incompleteCostData: true,
      incompleteReasons: ["missing_material_cost"],
      explanation: [`price:${input.priceMinor}`, "materials:unknown", `duration_minutes:${input.durationMinutes}`],
    };
  }

  assertNonNegativeInteger(input.materialCostMinor, "materialCostMinor");

  let commissionMinor: number;
  switch (input.commission.type) {
    case "percentage":
      assertNonNegativeInteger(input.commission.basisPoints, "commission.basisPoints");
      commissionMinor = roundRatio(input.priceMinor * input.commission.basisPoints, 10_000);
      break;
    case "fixed":
      assertNonNegativeInteger(input.commission.amountMinor, "commission.amountMinor");
      commissionMinor = input.commission.amountMinor;
      break;
    case "percentage_after_materials": {
      assertNonNegativeInteger(input.commission.basisPoints, "commission.basisPoints");
      const commissionBase = Math.max(0, input.priceMinor - input.materialCostMinor);
      commissionMinor = roundRatio(commissionBase * input.commission.basisPoints, 10_000);
      break;
    }
  }

  const contributionMarginMinor = input.priceMinor - input.materialCostMinor - commissionMinor;
  // A loss-making service must report its loss. Clamping these to zero would
  // contradict contributionMarginMinor and hide exactly what the product exists
  // to reveal. Margin percentage is undefined — not zero — for a free service.
  const marginBasisPoints =
    input.priceMinor === 0 ? null : roundRatio(contributionMarginMinor * 10_000, input.priceMinor);
  const profitPerHourMinor = roundRatio(contributionMarginMinor * 60, input.durationMinutes);

  return {
    formulaVersion: "costing-v1",
    currency: input.currency,
    priceMinor: input.priceMinor,
    durationMinutes: input.durationMinutes,
    incompleteCostData: false,
    materialCostMinor: input.materialCostMinor,
    commissionMinor,
    contributionMarginMinor,
    marginBasisPoints,
    profitPerHourMinor,
    explanation: [
      `price:${input.priceMinor}`,
      `materials:${input.materialCostMinor}`,
      `commission:${commissionMinor}`,
      `duration_minutes:${input.durationMinutes}`,
    ],
  };
}
