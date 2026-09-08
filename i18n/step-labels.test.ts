import { describe, expect, it } from "vitest";

import { stepMessageKey } from "@/i18n/step-labels";

describe("stepMessageKey", () => {
  it("sends the first step to the wording its reader was written for", () => {
    expect(stepMessageKey("step.goal.specialist", "solo")).toBe("step.goal.specialist.solo");
    expect(stepMessageKey("step.goal.specialist", "studio")).toBe("step.goal.specialist.studio");
  });

  it("leaves a step that reads the same for both exactly as it was", () => {
    // The cast the three screens used to make by hand, made in one place —
    // and it has to keep resolving, or a service step comes out blank.
    expect(stepMessageKey("step.goal.service", "solo")).toBe("step.goal.service");
    expect(stepMessageKey("onboarding.visitHint", "studio")).toBe("onboarding.visitHint");
  });

  // That every key it hands back exists in all three dictionaries is swept by
  // `components/onboarding-panel.test.ts`, which enumerates the keys the
  // screens actually assemble — including the month's, which do not come
  // through the table at all.
});
