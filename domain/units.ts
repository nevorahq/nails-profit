import { roundRatio } from "@/domain/money";

/**
 * Units and package arithmetic, spec CST-002 and CST-003.
 *
 * Quantities are integers in thousandths of a base unit ("milli-units"), for the
 * same reason money is integers in minor units: a recipe that needs 0.3 ml must
 * not become a float somewhere in the middle of a cost calculation.
 */

export const MILLI_UNITS_PER_BASE = 1000;

export type MaterialUnit = "ml" | "g" | "piece";

export const materialUnits = ["ml", "g", "piece"] as const;

export function toMilliUnits(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError("Quantity must be a non-negative finite number");
  }
  return Math.round(quantity * MILLI_UNITS_PER_BASE);
}

export function fromMilliUnits(milliUnits: number): number {
  return milliUnits / MILLI_UNITS_PER_BASE;
}

/**
 * Cost of one base unit, for display (CST-003). Rounded to minor units, so it is
 * NOT what a cost calculation should multiply — see `materialCostMinor`.
 *
 * Null when the package size is unknown or zero: a material whose package size
 * is missing has an unknown unit cost, and section 8.8.1 forbids treating an
 * unknown cost as free.
 */
export function baseUnitCostMinor(
  packagePriceMinor: number,
  packageSizeMilliUnits: number,
): number | null {
  if (!isUsablePackage(packagePriceMinor, packageSizeMilliUnits)) return null;
  return roundRatio(packagePriceMinor * MILLI_UNITS_PER_BASE, packageSizeMilliUnits);
}

/**
 * Cost of `quantityMilliUnits` of a material, rounded once at the end.
 *
 * Deliberately not `baseUnitCostMinor() * quantity`: rounding the per-unit price
 * first and multiplying afterwards multiplies the rounding error too. A 240 MDL
 * package of 7 ml rounds to 34.29 MDL/ml, and seven of those come to 240.03 MDL
 * rather than the 240 MDL actually paid. Rounding once keeps the arithmetic
 * closed over the package.
 */
export function materialCostMinor(
  packagePriceMinor: number,
  packageSizeMilliUnits: number,
  quantityMilliUnits: number,
): number | null {
  if (!isUsablePackage(packagePriceMinor, packageSizeMilliUnits)) return null;
  if (!Number.isSafeInteger(quantityMilliUnits) || quantityMilliUnits < 0) {
    throw new RangeError("quantityMilliUnits must be a non-negative integer");
  }
  return roundRatio(packagePriceMinor * quantityMilliUnits, packageSizeMilliUnits);
}

function isUsablePackage(packagePriceMinor: number, packageSizeMilliUnits: number): boolean {
  if (!Number.isSafeInteger(packageSizeMilliUnits) || packageSizeMilliUnits <= 0) return false;
  if (!Number.isSafeInteger(packagePriceMinor) || packagePriceMinor < 0) {
    throw new RangeError("packagePriceMinor must be a non-negative integer");
  }
  return true;
}
