import { describe, expect, it } from "vitest";

import { reportTabs } from "@/components/report-tabs";
import { memberRoles } from "@/domain/rbac";

describe("the report's tabs", () => {
  it("offers «Месяц подробно» to the owner and to nobody else", () => {
    // The month is rent and wages line by line; the `expenses` capability is
    // the owner's alone, and the page refuses everyone else on its own.
    for (const role of memberRoles) {
      const tabs = reportTabs(role, {}).map((item) => item.tab);
      expect(tabs, role).toEqual(
        role === "owner" ? ["summary", "services", "month", "payouts"] : ["summary", "services"],
      );
    }
  });

  it("offers «К выплате» to a studio, not to somebody working alone", () => {
    // Alone, the only card is the owner's own, and nobody is owed a payout.
    expect(reportTabs("owner", {}, "solo").map((item) => item.tab)).toEqual(["summary", "services", "month"]);
    expect(reportTabs("owner", {}, "studio").map((item) => item.tab)).toContain("payouts");
  });

  it("carries the period and the master between «Итог» and «Услуги»", () => {
    const tabs = reportTabs("owner", { from: "2026-09-01", to: "2026-09-30", specialist: "abc", month: "2026-09" });
    expect(tabs.map((item) => item.href)).toEqual([
      "/app?from=2026-09-01&to=2026-09-30&specialist=abc",
      "/app/reports/services?from=2026-09-01&to=2026-09-30&specialist=abc",
      "/app/reports/month?month=2026-09",
      "/app/reports/payouts?month=2026-09",
    ]);
  });

  it("leaves the default unsaid, so it stays the current month", () => {
    expect(reportTabs("owner", {}).map((item) => item.href)).toEqual([
      "/app",
      "/app/reports/services",
      "/app/reports/month",
      "/app/reports/payouts",
    ]);
  });
});
