import { toMilliUnits } from "@/domain/units";

export const materialCostingModes = [
  "quantity",
  "services_per_package",
  "fixed_per_service",
] as const;
export type MaterialCostingMode = (typeof materialCostingModes)[number];

export type MaterialPriceProfileInput =
  | Readonly<{
      mode: "quantity";
      packagePriceMinor: number;
      packageSize: number;
    }>
  | Readonly<{
      mode: "services_per_package";
      packagePriceMinor: number;
      servicesPerPackage: number;
    }>
  | Readonly<{
      mode: "fixed_per_service";
      fixedCostMinor: number;
    }>;

/**
 * Normalizes the three Simple Mode inputs into the package ratio the existing
 * costing engine already snapshots and evaluates. No parallel engine is
 * introduced: one service is one logical base unit for modes B and C.
 */
export function normalizeMaterialPriceProfile(input: MaterialPriceProfileInput) {
  switch (input.mode) {
    case "quantity":
      return {
        mode: input.mode,
        packagePriceMinor: input.packagePriceMinor,
        packageSizeMilliUnits: toMilliUnits(input.packageSize),
      };
    case "services_per_package":
      return {
        mode: input.mode,
        packagePriceMinor: input.packagePriceMinor,
        packageSizeMilliUnits: toMilliUnits(input.servicesPerPackage),
      };
    case "fixed_per_service":
      return {
        mode: input.mode,
        packagePriceMinor: input.fixedCostMinor,
        packageSizeMilliUnits: toMilliUnits(1),
      };
  }
}
