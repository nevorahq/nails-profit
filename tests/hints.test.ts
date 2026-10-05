import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";

/**
 * The long hints on the money screens: one line on the screen, the paragraph
 * behind «Подробнее» (`components/hint.tsx`).
 *
 * Read from the source rather than rendered — there is no renderer in this
 * repository, see `tests/accessibility.test.ts` — because the property is about
 * the source: wherever one of these paragraphs is printed, it is printed as the
 * `more` of a `Hint` and never again as a bare line.
 */
const HINTS = [
  { file: "components/labor-cost-manager.tsx", more: "businessLabel.laborHint[businessType]", short: "labor.hintShort" },
  { file: "app/app/reports/month/page.tsx", more: '"cash.hint"', short: "cash.hintShort" },
  {
    file: "app/app/reports/month/page.tsx",
    more: "businessLabel.principalHint[businessType]",
    short: "pl.principalHintShort",
  },
  { file: "components/service-detail.tsx", more: '"services.fullyLoadedHint"', short: "services.fullyLoadedHintShort" },
  { file: "components/specialist-detail.tsx", more: '"specialists.imputedHint"', short: "specialists.imputedHintShort" },
  { file: "components/specialist-manager.tsx", more: '"specialists.imputedHint"', short: "specialists.imputedHintShort" },
  { file: "components/tax-rule-manager.tsx", more: '"tax.hint"', short: "tax.hintShort" },
  { file: "app/app/reports/month/page.tsx", more: '"capacity.utilizationHint"', short: "capacity.utilizationHintShort" },
] as const;

describe("the long hints", () => {
  it.each(HINTS)("$more is behind «Подробнее» in $file", ({ file, more, short }) => {
    const source = readFileSync(file, "utf8");
    const uses = source.split(`t(${more}`).length - 1;
    const asMore = source.split(`more={t(${more}`).length - 1;

    expect(uses).toBeGreaterThan(0);
    expect(asMore).toBe(uses);
    expect(source).toContain(`short={t("${short}"`);
  });

  it("are one line in every language — shorter than what they open onto", () => {
    for (const locale of supportedLocales) {
      for (const [short, long] of [
        ["cash.hintShort", "cash.hint"],
        ["tax.hintShort", "tax.hint"],
        ["capacity.utilizationHintShort", "capacity.utilizationHint"],
        ["specialists.imputedHintShort", "specialists.imputedHint"],
        ["services.fullyLoadedHintShort", "services.fullyLoadedHint"],
        ["labor.hintShort", "labor.hint.studio"],
        ["pl.principalHintShort", "pl.principalHint.studio"],
      ] as const) {
        const line = dictionaries[locale][short] as string;
        expect(line.length, `${locale}/${short}`).toBeLessThan((dictionaries[locale][long] as string).length / 2);
        expect(line.split(/[.!?](\s|$)/).filter((part) => part.trim().length > 0).length).toBe(1);
      }
    }
  });
});
