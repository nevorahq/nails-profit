import { materialCostMinor } from "@/domain/units";

/** The origin of the quantity that ultimately participates in visit costing. */
export type MaterialUsageSource = "standard" | "actual";

export type MaterialUsageLine = Readonly<{
  materialId: string;
  standardQuantityMilliUnits: number;
  /** Null means no exception was recorded for this material. Zero is an explicit removal. */
  actualQuantityMilliUnits: number | null;
  packagePriceMinor: number | null;
  packageSizeMilliUnits: number | null;
}>;

export type ResolvedMaterialUsageItem = Readonly<{
  materialId: string;
  standardQuantityMilliUnits: number;
  actualQuantityMilliUnits: number | null;
  effectiveQuantityMilliUnits: number;
  standardCostMinor: number | null;
  effectiveCostMinor: number | null;
  source: MaterialUsageSource;
}>;

export type ResolvedMaterialUsage = Readonly<{
  items: readonly ResolvedMaterialUsageItem[];
  standardTotalMinor: number | null;
  effectiveTotalMinor: number | null;
  /** `actual` means at least one item was corrected; untouched items still use their standard. */
  source: MaterialUsageSource;
  blockingMaterialIds: readonly string[];
}>;

function cost(
  line: MaterialUsageLine,
  quantityMilliUnits: number,
): number | null {
  // An explicit zero means the material was not used. Its price is irrelevant
  // to this visit, so this is a real zero rather than an unknown price being
  // disguised as free.
  if (quantityMilliUnits === 0) return 0;
  if (line.packagePriceMinor === null || line.packageSizeMilliUnits === null) return null;
  return materialCostMinor(
    line.packagePriceMinor,
    line.packageSizeMilliUnits,
    quantityMilliUnits,
  );
}

/**
 * The single resolver used by visit costing.
 *
 * Overrides are per material. This makes a one-line correction safe: correcting
 * the gel does not erase the file, wipes and sanitation from the recipe. An
 * extra material is represented by a standard quantity of zero and an actual
 * quantity above zero.
 */
export function resolveEffectiveMaterialUsage(
  lines: readonly MaterialUsageLine[],
): ResolvedMaterialUsage {
  const items = lines.map((line): ResolvedMaterialUsageItem => {
    const source: MaterialUsageSource =
      line.actualQuantityMilliUnits === null ? "standard" : "actual";
    const effectiveQuantityMilliUnits =
      line.actualQuantityMilliUnits ?? line.standardQuantityMilliUnits;

    return {
      materialId: line.materialId,
      standardQuantityMilliUnits: line.standardQuantityMilliUnits,
      actualQuantityMilliUnits: line.actualQuantityMilliUnits,
      effectiveQuantityMilliUnits,
      standardCostMinor: cost(line, line.standardQuantityMilliUnits),
      effectiveCostMinor: cost(line, effectiveQuantityMilliUnits),
      source,
    };
  });

  const blockingMaterialIds = items
    .filter((item) => item.effectiveCostMinor === null)
    .map((item) => item.materialId);
  const standardBlocked = items.some((item) => item.standardCostMinor === null);
  const hasActual = items.some((item) => item.source === "actual");

  return {
    items,
    standardTotalMinor: standardBlocked
      ? null
      : items.reduce((total, item) => total + item.standardCostMinor!, 0),
    effectiveTotalMinor:
      blockingMaterialIds.length > 0
        ? null
        : items.reduce((total, item) => total + item.effectiveCostMinor!, 0),
    source: hasActual ? "actual" : "standard",
    blockingMaterialIds,
  };
}
