import { describe, expect, it } from "vitest";

import { materialsModeFor, usesPerServiceMaterials } from "./materials-mode";

describe("the mode a month was counted in", () => {
  it("is purchases for a studio that never chose", () => {
    expect(materialsModeFor([], "2026-10")).toBe("purchases");
  });

  it("is the latest change on or before the month, and the months before keep theirs", () => {
    const periods = [
      { mode: "per_service" as const, effectiveFrom: "2026-11-01" },
      { mode: "purchases" as const, effectiveFrom: "2027-02-01" },
    ];
    expect(materialsModeFor(periods, "2026-10")).toBe("purchases");
    expect(materialsModeFor(periods, "2026-11")).toBe("per_service");
    expect(materialsModeFor(periods, "2027-01")).toBe("per_service");
    expect(materialsModeFor(periods, "2027-02")).toBe("purchases");
  });

  it("does not depend on the order the changes are listed in", () => {
    const periods = [
      { mode: "purchases" as const, effectiveFrom: "2027-02-01" },
      { mode: "per_service" as const, effectiveFrom: "2026-11-01" },
    ];
    expect(materialsModeFor(periods, "2027-01")).toBe("per_service");
  });
});

describe("whether the amounts on services matter", () => {
  it("does now, and from a month already scheduled, but not otherwise", () => {
    expect(usesPerServiceMaterials([], "2026-10")).toBe(false);
    expect(usesPerServiceMaterials([{ mode: "per_service", effectiveFrom: "2026-10-01" }], "2026-10")).toBe(true);
    expect(usesPerServiceMaterials([{ mode: "per_service", effectiveFrom: "2026-11-01" }], "2026-10")).toBe(true);
    expect(
      usesPerServiceMaterials(
        [
          { mode: "per_service", effectiveFrom: "2026-01-01" },
          { mode: "purchases", effectiveFrom: "2026-06-01" },
        ],
        "2026-10",
      ),
    ).toBe(false);
  });
});
