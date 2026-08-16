import { MILLI_UNITS_PER_BASE } from "@/domain/units";
import { roundRatio } from "@/domain/money";

/**
 * Estimated stock, spec CST-011 and CST-012.
 *
 * Deliberately an estimate and deliberately not a warehouse. The owner is a
 * nail technician, not a storekeeper: the question this answers is "will I run
 * out of base before Friday", not "what is the audited value of my inventory".
 * So there is no lot tracking, no FIFO, no reservations and no stock document —
 * a balance is arithmetic over three lists the product already has a reason to
 * keep, and the interface states it in procedures rather than millilitres.
 *
 * The three lists are not symmetric. A stock check is a *measurement* and every
 * purchase and consumption before it is already inside the number the owner
 * read off the bottle; replaying them on top would count them twice. So a check
 * resets the baseline and only what happened after it is applied. That is what
 * makes the estimate self-correcting: recipes that overstate the usage drift
 * the balance, one check pulls it back, and the drift between the two is the
 * calibration signal in `calibrationSuggestion`.
 *
 * Pure, like every other `domain/` module: no database, no locale, no
 * formatting. That is what lets each rule below be a test.
 */

/**
 * How a count was arrived at. Exported as a list for the same reason the roles
 * are: the database enum is generated from it, so the two cannot drift.
 */
export const materialStockCheckBases = ["bucket", "measured"] as const;
export type MaterialStockCheckBasis = (typeof materialStockCheckBases)[number];

export type StockPurchaseEvent = Readonly<{
  at: Date;
  /** Packages × package size, already reduced to thousandths of the base unit. */
  quantityMilliUnits: number;
}>;

export type StockConsumptionEvent = Readonly<{
  at: Date;
  /** What the visit effectively used: the correction when there is one, else the recipe. */
  quantityMilliUnits: number;
}>;

export type StockCheckEvent = Readonly<{
  at: Date;
  observedQuantityMilliUnits: number;
}>;

export type StockBalance = Readonly<{
  /**
   * Thousandths of the base unit left, or null when nothing is known.
   *
   * Null rather than zero for the reason `baseUnitCostMinor` returns null on an
   * unknown package size: a material nobody has ever recorded buying has an
   * unknown balance, and "0" would read as "you are out" on a shelf that is
   * full.
   */
  milliUnits: number | null;
  /** Where the balance was measured from, so the interface can say how much to trust it. */
  basis: "check" | "purchases" | "unknown";
  /** When the baseline was established; null when there is none. */
  baselineAt: Date | null;
  /** Purchases and consumption applied on top of the baseline. */
  purchasedSinceMilliUnits: number;
  consumedSinceMilliUnits: number;
}>;

export type StockInput = Readonly<{
  purchases: readonly StockPurchaseEvent[];
  consumptions: readonly StockConsumptionEvent[];
  checks: readonly StockCheckEvent[];
  /** Everything after this instant is ignored, so a report can ask about a past date. */
  asOf?: Date;
}>;

function atOrBefore(at: Date, asOf: Date) {
  return at.getTime() <= asOf.getTime();
}

export function estimateStock(input: StockInput): StockBalance {
  const asOf = input.asOf ?? new Date();

  const checks = input.checks
    .filter((check) => atOrBefore(check.at, asOf))
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  const baseline = checks.at(-1) ?? null;

  /*
   * Strictly after the check, not at it. Two events sharing a timestamp is the
   * normal case in this codebase — `defaultNow()` on rows written in one
   * transaction — and a purchase recorded in the same breath as the count is
   * the crate the owner had just put on the shelf and already counted.
   */
  const after = (at: Date) => (baseline === null ? true : at.getTime() > baseline.at.getTime());

  const purchasedSinceMilliUnits = input.purchases
    .filter((purchase) => atOrBefore(purchase.at, asOf) && after(purchase.at))
    .reduce((total, purchase) => total + purchase.quantityMilliUnits, 0);

  const consumedSinceMilliUnits = input.consumptions
    .filter((line) => atOrBefore(line.at, asOf) && after(line.at))
    .reduce((total, line) => total + line.quantityMilliUnits, 0);

  if (baseline === null && purchasedSinceMilliUnits === 0) {
    return {
      milliUnits: null,
      basis: "unknown",
      baselineAt: null,
      purchasedSinceMilliUnits: 0,
      consumedSinceMilliUnits,
    };
  }

  const opening = baseline?.observedQuantityMilliUnits ?? 0;

  return {
    /*
     * Allowed to go negative and reported as it is. A negative balance is not a
     * database error, it is the estimate saying the recipes claim more was used
     * than was ever bought — which is a real thing to tell the owner, and
     * clamping it to zero would hide the one number that says the norms need
     * calibrating.
     */
    milliUnits: opening + purchasedSinceMilliUnits - consumedSinceMilliUnits,
    basis: baseline === null ? "purchases" : "check",
    baselineAt: baseline?.at ?? null,
    purchasedSinceMilliUnits,
    consumedSinceMilliUnits,
  };
}

/**
 * Average usage of this material per visit that actually used it.
 *
 * Measured rather than read off a recipe, because a material sits in several
 * recipes at different quantities and the mix of services sold is what decides
 * how fast the bottle empties. Null when nothing has been consumed yet; the
 * caller falls back to the recipe.
 */
export function averageUsagePerVisitMilliUnits(
  consumptions: readonly StockConsumptionEvent[],
): number | null {
  if (consumptions.length === 0) return null;
  const total = consumptions.reduce((sum, line) => sum + line.quantityMilliUnits, 0);
  if (total <= 0) return null;
  return roundRatio(total, consumptions.length);
}

/**
 * The balance restated as procedures, spec section 36: «≈18 процедур».
 *
 * This is the primary representation on purpose. "6.84 ml" is a number the
 * owner has to convert before it means anything; "enough for 18 more clients"
 * is the decision itself.
 */
export function remainingServices(
  balanceMilliUnits: number | null,
  perServiceMilliUnits: number | null,
): number | null {
  if (balanceMilliUnits === null) return null;
  if (perServiceMilliUnits === null || perServiceMilliUnits <= 0) return null;
  return Math.floor(balanceMilliUnits / perServiceMilliUnits);
}

export type StockStatus = "unknown" | "ok" | "low" | "out";

/**
 * Procedures left below which the material is worth mentioning.
 *
 * A count rather than a percentage: 20% of a 100-piece box of gloves is three
 * weeks of work, 20% of an 8 ml bottle of gel polish is two clients, and one
 * threshold that means both cannot exist. Not configurable yet — a per-material
 * minimum is CST-012's P1 half and needs a screen nobody has asked for.
 */
export const LOW_STOCK_SERVICE_THRESHOLD = 5;

export function stockStatus(
  balanceMilliUnits: number | null,
  servicesLeft: number | null,
): StockStatus {
  if (balanceMilliUnits === null) return "unknown";
  if (balanceMilliUnits <= 0) return "out";
  if (servicesLeft === null) return "ok";
  return servicesLeft <= LOW_STOCK_SERVICE_THRESHOLD ? "low" : "ok";
}

export type PurchaseCostEvent = Readonly<{
  packageQuantity: number;
  packageSizeMilliUnits: number;
  unitPackageCostMinor: number;
}>;

export type PurchaseAverages = Readonly<{
  /** Weighted by packages bought. Null when nothing has been purchased. */
  averagePackageCostMinor: number | null;
  /** Weighted by volume, so it stays comparable when the packaging changes. */
  averageBaseUnitCostMinor: number | null;
  packagesPurchased: number;
  totalSpentMinor: number;
}>;

/**
 * What the material has cost on average, spec section 35.
 *
 * Displayed, never stored, and never fed back into a visit. The cost basis in
 * this product is `material_price_version` — append-only, latest in force, and
 * snapshotted into the visit at closing time. Turning the average into the
 * basis would give the codebase two answers to "what does this cost", and the
 * one nobody typed would win. So the average is a statistic on the card that
 * says whether the price on file still resembles what is being paid.
 */
export function purchaseAverages(purchases: readonly PurchaseCostEvent[]): PurchaseAverages {
  const packagesPurchased = purchases.reduce((total, row) => total + row.packageQuantity, 0);
  const totalSpentMinor = purchases.reduce(
    (total, row) => total + row.packageQuantity * row.unitPackageCostMinor,
    0,
  );
  const totalMilliUnits = purchases.reduce(
    (total, row) => total + row.packageQuantity * row.packageSizeMilliUnits,
    0,
  );

  return {
    averagePackageCostMinor:
      packagesPurchased > 0 ? roundRatio(totalSpentMinor, packagesPurchased) : null,
    averageBaseUnitCostMinor:
      totalMilliUnits > 0 ? roundRatio(totalSpentMinor * MILLI_UNITS_PER_BASE, totalMilliUnits) : null,
    packagesPurchased,
    totalSpentMinor,
  };
}

export type CalibrationSuggestion = Readonly<{
  expectedMilliUnits: number;
  observedMilliUnits: number;
  /** Observed minus expected. Negative means the material ran out faster than the norms say. */
  driftMilliUnits: number;
  /**
   * How far the norms are off, in basis points of what was expected to be
   * consumed. Null when nothing was consumed in the window, where a ratio has
   * no meaning.
   */
  driftBasisPoints: number | null;
  /** True when the drift is large enough to be worth showing. */
  significant: boolean;
}>;

/** Below this the difference is measurement noise: the owner eyeballed a bottle. */
const CALIBRATION_SIGNIFICANCE_BASIS_POINTS = 2_000;

/**
 * Compares a fresh count against what the estimate expected, spec section 39.
 *
 * Reports the gap and stops there. Rewriting the recipe norms from it is
 * deliberately not done: a norm is what the owner said their work costs, and a
 * single eyeballed bottle is not evidence enough to overwrite it behind their
 * back. The suggestion is shown; applying it stays a decision.
 */
export function calibrationSuggestion(
  expectedMilliUnits: number,
  observedMilliUnits: number,
  consumedSinceMilliUnits: number,
): CalibrationSuggestion {
  const driftMilliUnits = observedMilliUnits - expectedMilliUnits;
  const driftBasisPoints =
    consumedSinceMilliUnits > 0
      ? roundRatio(Math.round(driftMilliUnits * 10_000), consumedSinceMilliUnits)
      : null;

  return {
    expectedMilliUnits,
    observedMilliUnits,
    driftMilliUnits,
    driftBasisPoints,
    significant:
      driftBasisPoints !== null &&
      Math.abs(driftBasisPoints) >= CALIBRATION_SIGNIFICANCE_BASIS_POINTS,
  };
}
