import { describe, expect, it } from "vitest";

import { normalizeMaterialPriceProfile } from "@/domain/material-pricing";
import { materialCostMinor, toMilliUnits } from "@/domain/units";

describe("Simple Mode material pricing", () => {
  it("normalizes quantity pricing", () => {
    const profile = normalizeMaterialPriceProfile({
      mode: "quantity",
      packagePriceMinor: 15_000,
      packageSize: 15,
    });
    expect(materialCostMinor(profile.packagePriceMinor, profile.packageSizeMilliUnits, toMilliUnits(0.3))).toBe(300);
  });

  it("normalizes services-per-package pricing", () => {
    const profile = normalizeMaterialPriceProfile({
      mode: "services_per_package",
      packagePriceMinor: 50_000,
      servicesPerPackage: 40,
    });
    expect(materialCostMinor(profile.packagePriceMinor, profile.packageSizeMilliUnits, toMilliUnits(1))).toBe(1_250);
  });

  it("normalizes fixed-per-service pricing", () => {
    const profile = normalizeMaterialPriceProfile({
      mode: "fixed_per_service",
      fixedCostMinor: 150,
    });
    expect(materialCostMinor(profile.packagePriceMinor, profile.packageSizeMilliUnits, toMilliUnits(1))).toBe(150);
  });
});
