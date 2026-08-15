import { describe, expect, it } from "vitest";

import { serviceCatalogue, serviceSuggestions } from "@/domain/service-catalogue";

describe("the fixed catalogue of service kinds", () => {
  it("is the ten kinds the product offers", () => {
    expect(serviceCatalogue).toHaveLength(10);
    expect(new Set(serviceCatalogue.map((entry) => entry.key)).size).toBe(10);
  });

  it("names every kind in all three pilot languages", () => {
    for (const entry of serviceCatalogue) {
      expect(entry.name.ru?.trim(), entry.key).toBeTruthy();
      expect(entry.name.ro?.trim(), entry.key).toBeTruthy();
      expect(entry.name.en?.trim(), entry.key).toBeTruthy();
    }
  });

  it("offers everything before anything is typed", () => {
    expect(serviceSuggestions("")).toHaveLength(serviceCatalogue.length);
    expect(serviceSuggestions("   ")).toHaveLength(serviceCatalogue.length);
  });

  it("matches on a prefix of the name", () => {
    expect(serviceSuggestions("педи").map((entry) => entry.key)).toEqual(["pedicure"]);
  });

  it("matches whatever language the owner types in", () => {
    // A Romanian-speaking owner typing "pedi" means the same row as a
    // Russian-speaking one typing "педи".
    expect(serviceSuggestions("pedi").map((entry) => entry.key)).toEqual(["pedicure"]);
    expect(serviceSuggestions("manichi").map((entry) => entry.key)).toEqual(["manicure"]);
  });

  it("ignores case and the ё/е split half the keyboards have", () => {
    expect(serviceSuggestions("МАНИКЮР").map((entry) => entry.key)).toEqual(["manicure"]);
    expect(serviceSuggestions("уход").map((entry) => entry.key)).toEqual(["spa"]);
  });

  it("offers nothing for a name of the owner's own, rather than a wrong guess", () => {
    expect(serviceSuggestions("Комплекс с парафинотерапией")).toEqual([]);
  });
});
