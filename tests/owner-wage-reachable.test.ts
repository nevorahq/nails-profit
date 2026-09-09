import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The one instruction the monthly report gives that used to lead nowhere.
 *
 * Economic profit is not computed until the owner says what their own work is
 * worth. The report used to say so with a link to `/app/settings` while
 * `SHOW_ADVANCED_FINANCIAL_SETTINGS` kept the control that answers it off that
 * page: the product asked for a number, offered a door, and put nothing behind
 * it. «Оплата труда за месяц» is hidden again now — and this time the report
 * asks for nothing, which is the other way to close the same gap.
 *
 * Read from the source rather than rendered: there is no renderer in this
 * repository — see `tests/accessibility.test.ts` for why — and "the screen this
 * link points at offers the control it names" is a property of the source.
 *
 * So what is asserted is the pairing, not either half. Bringing the block back
 * is free; putting the instruction back without it is what this refuses, in
 * either order.
 */
const report = readFileSync("app/app/reports/month/page.tsx", "utf8");
const settings = readFileSync("app/app/settings/page.tsx", "utf8");

describe("the owner's wage is never asked for through a door onto nothing", () => {
  const sendsPeopleToSettings =
    report.includes("pl.setOwnerWage") || report.includes('href="/app/settings"');

  const settingsOfferTheControl = (() => {
    if (!settings.includes("<LaborCostManager")) return false;
    const assignment = /const\s+canReadLabour\s*=([\s\S]*?);/.exec(settings);
    if (assignment === null) return false;
    return !assignment[1].includes("SHOW_ADVANCED_FINANCIAL_SETTINGS");
  })();

  it("keeps the instruction and the control together", () => {
    expect(sendsPeopleToSettings && !settingsOfferTheControl).toBe(false);
  });

  /*
   * Both halves, stated out loud, so that flipping one of them fails here and
   * says which way round the product currently stands — rather than leaving the
   * implication above quietly satisfied by two absences nobody chose.
   */
  it("is where the two of them were last left", () => {
    expect({ sendsPeopleToSettings, settingsOfferTheControl }).toEqual({
      sendsPeopleToSettings: false,
      settingsOfferTheControl: false,
    });
  });
});
