import { describe, expect, it } from "vitest";

import { catalogueEntry, serviceCatalogue, serviceSuggestions } from "@/domain/service-catalogue";
import { DEFAULT_SERVICE } from "@/domain/workspace-defaults";

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

  it("gives every kind a duration the setup screen can fill a field with", () => {
    // Half the answer to «сколько я зарабатываю в час», and the half nobody
    // wants to type ten times on their first minute in the product.
    for (const entry of serviceCatalogue) {
      expect(entry.durationMinutes, entry.key).toBeGreaterThan(0);
      expect(Number.isSafeInteger(entry.durationMinutes), entry.key).toBe(true);
    }
  });

  it("knows the kind a studio is registered with", () => {
    // `DEFAULT_SERVICE` names a key, and a key the catalogue does not have
    // would register a studio with no catalogue at all.
    expect(catalogueEntry(DEFAULT_SERVICE.key)).not.toBeNull();
  });

  it("resolves a stored key, and refuses one it does not know", () => {
    // What the create-organization endpoint trusts instead of a name sent by
    // the browser — a key it cannot resolve is a 422, not a service.
    expect(catalogueEntry("pedicure")?.name.ru).toBe("Педикюр");
    expect(catalogueEntry("levitation")).toBeNull();
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
