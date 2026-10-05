import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * «Сколько я заработала в этом месяце» — answered by the first thing on the
 * report, on a phone, without scrolling.
 *
 * The canonical studio closes two 600 MDL manicures by its master at 40% and
 * pays 300 MDL of rent this month. The owner's card has to be the monthly
 * report's operating profit to the cent; the master's, their 480 MDL of
 * commission. Both at 375 × 667, the smallest phone still in common use, where
 * «visible» means inside the first screen rather than somewhere below it.
 */
test.use({ viewport: { width: 375, height: 667 } });

async function inFirstScreen(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, "the figure has a box").not.toBeNull();
  expect(box!.y + box!.height, "the figure sits above the fold").toBeLessThanOrEqual(viewport!.height);
  expect(await page.evaluate(() => window.scrollY), "nothing was scrolled to reach it").toBe(0);
}

test.describe("the report's first figure", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    for (let visit = 0; visit < 2; visit += 1) {
      await studio.owner.post("/api/v1/visits", {
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
      });
    }
    await studio.owner.post("/api/v1/expenses", {
      name: "Rent",
      category: "rent",
      amount_minor: 30_000,
      spent_on: new Date().toISOString().slice(0, 10),
    });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("is the owner's operating profit, the same as the month's own report", async ({
    baseURL,
    browser,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Left for you this month" })).toBeVisible();
    const figure = page.getByTestId("headline-value");
    await inFirstScreen(page, figure);
    await page.screenshot({ path: testInfo.outputPath("owner-375.png") });

    // 1 200 of revenue, 480 to the master, 300 of rent.
    await expect(figure).toHaveText("MDL 420.00");
    await expect(page.locator(".headline-card")).toContainText("Revenue MDL 1,200.00 − costs MDL 780.00");

    await page.getByRole("link", { name: "How it adds up →" }).click();
    await page.waitForURL("**/app/reports/month");
    const operating = page.locator(".pl-total").first().locator("td").last();
    await expect(operating).toHaveText("MDL 420.00");
    await context.close();
  });

  test("is the master's own earnings, and nothing of the studio's", async ({
    baseURL,
    browser,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.master, baseURL!);
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Your earnings this month" })).toBeVisible();
    const figure = page.getByTestId("headline-value");
    await inFirstScreen(page, figure);
    await expect(figure).toHaveText("MDL 480.00");
    await page.screenshot({ path: testInfo.outputPath("master-375.png") });

    // The rent and the studio's month are not theirs: no split line, no
    // break-even, and no way into the month's statement.
    const card = page.locator(".headline-card");
    await expect(card).not.toContainText("costs");
    await expect(page.getByRole("link", { name: "How it adds up →" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Month in detail" })).toHaveCount(0);
    await context.close();
  });

  test("gives the owner's phone three sections, «More» and a «+» with three ways in", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto("/app");

    const bar = page.getByRole("navigation", { name: "Primary navigation" }).last();
    await expect(bar.getByRole("link")).toHaveText(["Report", "Calendar", "Clients", "More"]);

    await page.getByLabel("Add", { exact: true }).click();
    await expect(page.locator(".quick-actions-menu").getByRole("link")).toHaveText([
      "Book a client",
      "Close a visit without a booking",
      "Add an expense",
    ]);
    await page.getByRole("link", { name: "Add an expense" }).click();
    await page.waitForURL("**/app/expenses#add-expense");
    await expect(page.getByLabel("Purchase amount")).toBeVisible();
    await expect(page.locator(".quick-actions")).not.toHaveAttribute("open", "");
    await context.close();
  });

  test("leaves a master's phone bar as it was, with no «+»", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.master, baseURL!);
    const page = await context.newPage();
    await page.goto("/app");

    const bar = page.getByRole("navigation", { name: "Primary navigation" }).last();
    await expect(bar.getByRole("link")).toHaveText(["Report", "Calendar", "Online booking", "More"]);
    await expect(page.getByLabel("Add", { exact: true })).toHaveCount(0);
    await context.close();
  });
});
