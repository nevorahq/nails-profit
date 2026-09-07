import { describe, expect, it } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";

/**
 * These screens name their strings by building the key — `onboarding.` or
 * `monthSetup.` plus the step, plus `Hint` — and a built key is cast past the
 * type system on its way to `t()`. So the one guarantee `tsc` gives everywhere
 * else in this dictionary does not hold here, and a step renamed in
 * `lib/onboarding.ts` would reach a pilot's screen as the literal
 * `onboarding.visitHint` instead of a sentence.
 *
 * Three screens build keys this way: the first-run checklist on the dashboard,
 * the goal panels (`step.goal.` and `step.action.`), and the guided window,
 * which borrows both to name the button that carries somebody onward. A step
 * renamed without them would put `step.action.visit` on a button.
 *
 * The two runs need different strings, which is why they are listed apart. The
 * first run is drawn as a checklist and needs a heading, a progress line and a
 * reason under each step. The month is drawn as a goal — one instruction and
 * one button — and needs only its step names, for the link back to the step
 * before.
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
    // other half of the same journey. It ends on a title alone.
    "setupGuide.title",
    "setupGuide.doneTitle",
    "setupGuide.doneAction",
    // The month's window, which is the same journey run a second time, and does
    // still say what its last step changed in the report.
    "monthGuide.title",
    "monthGuide.doneTitle",
    "monthGuide.doneBody",
    "monthGuide.doneAction",
    // The goal panels: the first run, and the month's setup under the report.
    "firstRun.title",
    "step.remaining",
    "step.back",
    // Every step of both checklists is named twice more — as a goal and as the
    // button that goes and does it.
    ...Object.values(STEPS)
      .flat()
      .flatMap((step) => [`step.goal.${step}`, `step.action.${step}`]),
    // The dashboard checklist, which is the first run only.
    "onboarding.title",
    "onboarding.progress",
    ...STEPS.onboarding.flatMap((step) => [`onboarding.${step}`, `onboarding.${step}Hint`]),
    // The month, whose step names survive as the label on «назад».
    ...STEPS.monthSetup.map((step) => `monthSetup.${step}`),
  ];

  for (const locale of supportedLocales) {
    it(`says every step and every reason in ${locale}`, () => {
      const table = dictionaries[locale] as Record<string, unknown>;
      expect(required.filter((key) => table[key] === undefined)).toEqual([]);
    });
  }

  it("counts the steps in the progress line", () => {
    for (const locale of supportedLocales) {
      const line = (dictionaries[locale] as Record<string, string>)["onboarding.progress"];
      expect(line).toContain("{done}");
      expect(line).toContain("{total}");
    }
  });
});
