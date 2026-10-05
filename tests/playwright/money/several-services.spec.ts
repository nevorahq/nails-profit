import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { daysFromToday, disposeStudio, isoDate, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * A manicure and a pedicure in one sitting, on both screens that describe one.
 *
 * Canonical studio: a 600 MDL manicure for 90 minutes at 40%, plus a 400 MDL
 * pedicure for 60 minutes added here. Closing both as one visit must reach the
 * list as one visit of 1 000 named by both services, and booking both from the
 * calendar as one appointment of two and a half hours.
 */
async function addPedicure(studio: Studio) {
  return studio.owner.post<{ id: string }>("/api/v1/services", {
    name: { en: "Pedicure" },
    price_minor: 40_000,
    duration_minutes: 60,
  });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const width of [null, 375] as const) {
  test.describe(`several services in one sitting${width ? ` at ${width} px` : ""}`, () => {
    let studio: Studio;
    if (width) test.use({ viewport: { width, height: 812 } });

    test.beforeEach(async ({ baseURL }, testInfo) => {
      studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
      await addPedicure(studio);
    });

    test.afterEach(async () => {
      if (studio) await disposeStudio(studio);
    });

    test("a visit of two services is closed as one", async ({ browser, baseURL, browserErrors }, testInfo) => {
      void browserErrors;
      const context = await signedInContext(browser, studio.owner, baseURL!);
      const page = await context.newPage();
      await page.goto("/app/visits/new");

      const paid = page.getByLabel("Client paid, MDL");
      await expect(paid).toHaveValue("600");

      await page.getByRole("button", { name: "+ Another service" }).click();
      await expect(page.getByRole("combobox", { name: /^Service 2/ })).toHaveValue(/.+/);
      await expect(page.getByRole("combobox", { name: /^Service 2/ }).locator("option:checked")).toHaveText("Pedicure");
      // The first select is renumbered, and does not offer the pedicure twice.
      await expect(page.getByRole("combobox", { name: /^Service 1/ }).locator("option")).toHaveText(["Manicure with coating"]);
      // The amount follows the whole sitting until somebody types.
      await expect(paid).toHaveValue("1000");
      await expect(page.locator("main")).toContainText("150");

      await noSidewaysScroll(page);
      await page.screenshot({ path: testInfo.outputPath("close-form-two-services.png"), fullPage: true });

      // Taken out again, it is a visit of one.
      await page.getByRole("button", { name: "Remove service 2" }).click();
      await expect(paid).toHaveValue("600");
      await expect(page.getByRole("combobox", { name: /^Service/ })).toHaveCount(1);
      await page.getByRole("button", { name: "+ Another service" }).click();

      await page.getByRole("button", { name: "Close a visit" }).click();
      await page.waitForURL("**/app/visits");
      await expect(page.locator(".visit-card-service").first()).toContainText("Manicure with coating + Pedicure");
      const total = page.locator(".visit-card-total").first();
      await expect(total).toContainText("MDL 1,000.00");
      // 40% of both: one default rule covers the two services.
      await expect(total).toContainText("MDL 400.00");
      await noSidewaysScroll(page);

      // The ranking has a row for each service, and its total counts the visit once.
      // Every column lives on «Услуги»; «Итог» shows the short form.
      await page.goto("/app/reports/services");
      const ranking = page.locator("table.data-table").filter({ has: page.locator("tfoot") }).last();
      await expect(ranking.locator("tbody tr")).toHaveCount(2);
      await expect(ranking.locator("tfoot td").first()).toHaveText("1");
      await context.close();
    });

    test("an appointment of two services is booked as one", async ({ browser, baseURL, browserErrors }, testInfo) => {
      void browserErrors;
      const day = daysFromToday(2);
      const context = await signedInContext(browser, studio.owner, baseURL!);
      const page = await context.newPage();
      await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);

      const compose = page.locator("#new-booking");
      if (!(await compose.evaluate((element) => (element as HTMLDetailsElement).open))) {
        await compose.locator("summary").click();
      }
      await compose.getByLabel("Specialist").selectOption({ label: studio.specialistName });
      await compose.getByRole("button", { name: "+ Another service" }).click();
      await expect(compose.getByRole("combobox", { name: /^Service 2/ }).locator("option:checked")).toHaveText("Pedicure");
      await compose.getByLabel("Date").fill(isoDate(day));
      await compose.getByLabel("Time").fill("10:00");
      await compose.getByLabel("New client's name").fill("Anna Two-Services");

      await noSidewaysScroll(page);
      await page.screenshot({ path: testInfo.outputPath("calendar-two-services.png"), fullPage: true });
      await compose.getByRole("button", { name: "Book" }).click();

      const entry = page.locator(".calendar-entry").filter({ hasText: "Anna Two-Services" });
      await expect(entry).toHaveCount(1);
      await expect(entry).toContainText("Manicure with coating + Pedicure");
      // 90 + 60 minutes from ten.
      await expect(entry).toContainText("10:00");
      await expect(entry).toContainText("12:30");
      await context.close();
    });
  });
}
