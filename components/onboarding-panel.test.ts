import { describe, expect, it } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";

/**
 * The checklist panel names its strings by building the key — `onboarding.` or
 * `monthSetup.` plus the step, plus `Hint` — and a built key is cast past the
 * type system on its way to `t()`. So the one guarantee `tsc` gives everywhere
 * else in this dictionary does not hold here, and a step renamed in
 * `lib/onboarding.ts` would reach a pilot's screen as the literal
 * `onboarding.visitHint` instead of a sentence.
 *
 * The step keys are repeated below rather than imported: importing them from
 * the module under test would let a rename pass unnoticed, which is the whole
 * of what this checks.
 */
const STEPS: Readonly<Record<"onboarding" | "monthSetup", readonly string[]>> = {
  onboarding: ["specialist", "service", "visit"],
  monthSetup: ["overhead", "rota"],
};

describe("checklist strings", () => {
  const required = [
    // The guided-setup window, which names its strings the same way and is the
    // other half of the same journey.
    "setupGuide.title",
    "setupGuide.body",
    "setupGuide.back",
    "setupGuide.stay",
    "setupGuide.toVisits",
    "setupGuide.doneTitle",
    "setupGuide.doneBody",
    "setupGuide.doneAction",
    ...Object.entries(STEPS).flatMap(([prefix, steps]) => [
      `${prefix}.title`,
      `${prefix}.progress`,
      ...steps.map((step) => `${prefix}.${step}`),
    ]),
  ];

  for (const locale of supportedLocales) {
    it(`says every step and every reason in ${locale}`, () => {
      const table = dictionaries[locale] as Record<string, unknown>;
      expect(required.filter((key) => table[key] === undefined)).toEqual([]);
    });
  }

  it("counts the steps in the progress line", () => {
    for (const [prefix] of Object.entries(STEPS)) {
      for (const locale of supportedLocales) {
        const line = (dictionaries[locale] as Record<string, string>)[`${prefix}.progress`];
        expect(line).toContain("{done}");
        expect(line).toContain("{total}");
      }
    }
  });
});
