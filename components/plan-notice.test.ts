import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanNotice } from "@/components/plan-notice";

describe("PlanNotice", () => {
  it("names the tier that opens every period and leads to the subscription block", () => {
    const html = renderToStaticMarkup(createElement(PlanNotice, { feature: "full_reports", locale: "ru" }));
    expect(html).toContain("На «Старте» отчёт — за текущий месяц. Любой период открывает тариф «Соло».");
    expect(html).toContain('href="/app/settings#subscription"');
  });
});
