import { describe, expect, it } from "vitest";

import { businessLabel, businessTypes, isBusinessType } from "@/i18n/business-labels";
import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";

/**
 * The label table is the only place `organization.type` is allowed to reach.
 *
 * Two things can rot here and neither shows up in a type check: a variant that
 * was never translated into Romanian, and a pair that says the same thing twice
 * — which means the entry earns nothing and should not be paid for in three
 * languages forever.
 */
describe("business labels", () => {
  const entries = Object.entries(businessLabel);

  it("has both variants of every label in every locale", () => {
    const missing = entries.flatMap(([name, variants]) =>
      supportedLocales.flatMap((locale) =>
        businessTypes
          .filter((type) => dictionaries[locale][variants[type]] === undefined)
          .map((type) => `${locale}/${name}.${type}`),
      ),
    );

    expect(missing).toEqual([]);
  });

  it("says something different for each, or it would not be here", () => {
    const identical = entries.flatMap(([name, variants]) =>
      supportedLocales
        .filter((locale) => dictionaries[locale][variants.solo] === dictionaries[locale][variants.studio])
        .map((locale) => `${locale}/${name}`),
    );

    expect(identical).toEqual([]);
  });

  it("keeps the divergence small enough to read in one sitting", () => {
    // Not a style rule: every entry is a sentence written twice and translated
    // three times, forever. Growth means the two shapes of business are
    // becoming two products, which is a decision to take on purpose rather
    // than to arrive at.
    //
    // Taken on purpose at twelve, in September 2026. The monthly report was
    // the whole of the divergence until then; what pushed past it was the
    // finding that a solo studio meets studio wording long before it ever
    // opens that report — on the service card where it sets prices, and on the
    // first screen after registration, which asked a woman working alone to
    // hire somebody. Both are the same sentence the report already makes, said
    // where the decision is actually taken. Sixteen is the new ceiling and it
    // is not a target: the next entry should have to argue for itself the same
    // way these did.
    expect(entries.length).toBeLessThanOrEqual(16);
  });

  it("recognises the two types and nothing else", () => {
    expect(isBusinessType("solo")).toBe(true);
    expect(isBusinessType("studio")).toBe(true);
    expect(isBusinessType("Solo")).toBe(false);
    expect(isBusinessType("freelance")).toBe(false);
  });
});
