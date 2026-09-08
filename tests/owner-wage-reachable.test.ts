import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The one instruction the monthly report gives that used to lead nowhere.
 *
 * Economic profit is not computed until the owner says what their own work is
 * worth, and the report says so with a link to `/app/settings` — while
 * `SHOW_ADVANCED_FINANCIAL_SETTINGS` kept the control that answers it off that
 * page. So the product asked for a number, offered a door, and put nothing
 * behind it; «Резерв» and «Можно вывести», which live in the same block, were
 * unreachable with it. A solo studio meets this first, because what its own
 * hour is worth is the question it came to ask.
 *
 * Read from the source rather than rendered: there is no renderer in this
 * repository — see `tests/accessibility.test.ts` for why — and "the screen this
 * link points at offers the control it names" is a property of the source.
 *
 * The two halves are asserted together on purpose. Removing the report's
 * instruction is a perfectly good way to fix the dead end; quietly re-hiding
 * the block while the instruction stands is not, and that is the only thing
 * this refuses.
 */
const report = readFileSync("app/app/reports/month/page.tsx", "utf8");
const settings = readFileSync("app/app/settings/page.tsx", "utf8");

describe("the owner's wage is reachable from the report that asks for it", () => {
  const sendsPeopleToSettings =
    report.includes("pl.setOwnerWage") && report.includes('href="/app/settings"');

  it("still points at the settings page", () => {
    // Guards the premise of the test below. If this goes false the report has
    // stopped asking, and the assertion after it stops applying — say so out
    // loud rather than letting the file quietly test nothing.
    expect(sendsPeopleToSettings).toBe(true);
  });

  it("does not hide the control behind the advanced-settings flag", () => {
    const assignment = /const\s+canReadLabour\s*=([\s\S]*?);/.exec(settings);
    expect(assignment).not.toBeNull();
    expect(assignment![1]).not.toContain("SHOW_ADVANCED_FINANCIAL_SETTINGS");
  });

  it("renders the block the link promises", () => {
    expect(settings).toContain("<LaborCostManager");
  });
});
