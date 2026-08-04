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

export type CostingResult = Readonly<{
  formulaVersion: "costing-v1";
  currency: Currency;
  priceMinor: number;
  materialCostMinor: number;
  commissionMinor: number;
  contributionMarginMinor: number;
  /** Null when the price is zero, where a margin percentage has no meaning. */
  marginBasisPoints: number | null;
  profitPerHourMinor: number;
  explanation: readonly string[];
}>;

function assertNonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

export function calculateCosting(input: CostingInput): CostingResult {
  assertNonNegativeInteger(input.priceMinor, "priceMinor");
  if (input.materialCostMinor === null) {
    throw new Error("INCOMPLETE_MATERIAL_COST");
  }
  assertNonNegativeInteger(input.materialCostMinor, "materialCostMinor");
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new RangeError("durationMinutes must be a positive integer");
  }

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
