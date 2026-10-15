import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanNotice, type PlanLimit } from "@/components/plan-notice";

describe("PlanNotice", () => {
  it("names the tier that opens every period and leads to the subscription block", () => {
    const html = renderToStaticMarkup(createElement(PlanNotice, { limit: "full_reports", locale: "ru" }));
    expect(html).toContain("На «Старте» отчёт — за текущий месяц. Любой период открывает тариф «Соло».");
    expect(html).toContain('href="/app/settings#subscription"');
  });

  it("names the tier each hidden control waits for", () => {
    const cases: [PlanLimit, string][] = [
      ["expenses", "Adding expenses starts with the Solo plan."],
      ["import", "Importing clients and services opens with the Solo plan."],
      ["team", "Inviting colleagues starts with the Studio plan."],
      ["specialists", "The Studio plan opens the team."],
      ["locations", "A second location opens with the Business plan."],
    ];
    for (const [limit, text] of cases) {
      const html = renderToStaticMarkup(createElement(PlanNotice, { limit, locale: "en" }));
      expect(html).toContain(text);
      expect(html).toContain(">Choose a plan</a>");
    }
  });
});
