import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, type Studio } from "../helpers/studio";

/**
 * Saying which master comes first, from the card itself.
 *
 * `specialist.sort_order` was read in three places from the day it was added
 * and written by nothing: the public list, the assignment «Любой доступный»
 * makes between two equally free masters, and the order of «Онлайн-запись».
 * Every card kept the default, so the tie fell through to comparing UUIDs and
 * one master silently took every hour of an empty day.
 *
 * The endpoint is covered by `tests/e2e/specialist-order.test.ts`. What only a
 * browser can answer is whether the control that reaches it exists on the page
 * at all, saves, and survives a reload — the three ways a form wired to the
 * right endpoint still fails the person using it.
 */
test.describe("the order of masters", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  /**
   * The order panel, and not the commission rule below it: both are saved by a
   * button with the same word on it, which a page-wide locator cannot tell
   * apart.
   */
  const orderPanel = (page: Page) =>
    page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Order" }) });

  /** The names in the list, top to bottom. */
  const listedNames = (page: Page) =>
    page.locator(".data-table tbody tr .specialist-photo-name a");

  test("is set on a master's card and reorders the list", async ({ browser, browserErrors }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    // Both cards start at the default, so the list is in the order they were
    // hired in — the master first, the colleague catalogued after her.
    await page.goto("/app/specialists");
    await expect(listedNames(page)).toHaveText([studio.specialistName, studio.colleagueName]);

    await page.goto(`/app/specialists/${studio.colleagueId}`);
    await expect(orderPanel(page).getByLabel("Position in the list")).toHaveValue("0");

    // Moving the master back is what puts the colleague in front, and she was
    // catalogued second — without this she stays second forever.
    await page.goto(`/app/specialists/${studio.specialistId}`);
    await orderPanel(page).getByLabel("Position in the list").fill("1");
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(`/api/v1/specialists/${studio.specialistId}`) &&
          response.request().method() === "PATCH",
      ),
      orderPanel(page).getByRole("button", { name: "Save" }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);

    await page.goto("/app/specialists");
    await expect(listedNames(page)).toHaveText([studio.colleagueName, studio.specialistName]);

    // The saved answer rather than a number left in an input: the card is
    // re-read from the database on a fresh load.
    await page.goto(`/app/specialists/${studio.specialistId}`);
    await expect(orderPanel(page).getByLabel("Position in the list")).toHaveValue("1");

    await context.close();
  });

  test("is not offered to a master reading their own card", async ({ browser, browserErrors }) => {
    void browserErrors;
    // Section 6.1 leaves the catalogue to the owner. The panel is the control,
    // so a reader who cannot change the order is not shown a field that would
    // refuse them.
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/specialists/${studio.specialistId}`);
    await expect(page.locator(".app-header h1")).toHaveText(studio.specialistName);
    await expect(orderPanel(page)).toHaveCount(0);

    await context.close();
  });
});
