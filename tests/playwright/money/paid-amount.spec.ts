import type { Browser } from "@playwright/test";

import { expect, test } from "../fixtures";
import {
  bookAppointment,
  daysFromToday,
  disposeStudio,
  isoDate,
  moveIntoThePast,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * «Клиент заплатил» on both screens a visit is closed from.
 *
 * Canonical studio: a 600 MDL service at 40%. Typing 500 must reach the visits
 * list as 500 taken and 200 earned; typing 650 as 650 and 260. The field is
 * read through the screens because that is where a wrong default — the field
 * forgetting to follow the price, or sending an amount nobody typed — would
 * show up.
 */
/**
 * The owner's browser, with cookie consent already answered.
 *
 * The fixture declines consent for its own page only; a context made here
 * would otherwise open with the banner, which on a phone sits over the very
 * button these tests press.
 */
async function ownerContext(browser: Browser, studio: Studio, baseURL: string) {
  const context = await browser.newContext({ storageState: await studio.owner.storageState() });
  await context.addCookies([
    {
      name: "npo_cookie_consent",
      value: encodeURIComponent(JSON.stringify({ analytics: false, updatedAt: "2026-01-01T00:00:00.000Z" })),
      url: baseURL,
      sameSite: "Lax",
    },
  ]);
  return context;
}

test.describe("what the client paid", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("closing an appointment for less records a discount", async ({ browser, baseURL, browserErrors }, testInfo) => {
    void browserErrors;
    const booking = await bookAppointment(studio.owner, studio, { startsAt: daysFromToday(1) });
    const startsAt = await moveIntoThePast(studio, booking.id);

    const context = await ownerContext(browser, studio, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(startsAt)}&specialist=${studio.specialistId}`);

    const entry = page.locator(".calendar-entry");
    await expect(entry).toHaveCount(1);
    const card = entry.locator("details").first();
    if (!(await card.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await entry.locator("summary").first().click();
    }

    await entry.getByText("Different amount or duration").click();
    const paid = entry.getByLabel("Client paid, MDL");
    // Pre-filled with the booking's «Итого», so the usual close is untouched.
    await expect(paid).toHaveValue("600");

    await paid.fill("500");
    await expect(entry).toContainText("MDL 100.00 off the price list");
    await page.screenshot({ path: testInfo.outputPath("calendar-paid-less.png"), fullPage: true });

    await entry
      .locator("details.calendar-subform form")
      .getByRole("button", { name: "Close into a visit" })
      .click();
    await expect(entry).toContainText("Completed");

    await page.goto("/app/visits");
    const total = page.locator(".visit-card-total");
    await expect(total).toContainText("MDL 500.00");
    await expect(total).toContainText("MDL 200.00");
    await context.close();
  });

  test("closing a walk-in for more records a surcharge", async ({ browser, baseURL, browserErrors }, testInfo) => {
    void browserErrors;
    const context = await ownerContext(browser, studio, baseURL!);
    const page = await context.newPage();
    await page.goto("/app/visits/new");

    const paid = page.getByLabel("Client paid, MDL");
    await expect(paid).toHaveValue("600");
    await paid.fill("650,00");
    await expect(page.locator("main")).toContainText("MDL 50.00 above the price list");

    await paid.fill("6x0");
    await expect(page.locator("main")).toContainText("Enter the amount as a number");
    await expect(page.getByRole("button", { name: "Close a visit" })).toBeDisabled();

    await paid.fill("650");
    await page.screenshot({ path: testInfo.outputPath("close-form-paid-more.png"), fullPage: true });
    await page.getByRole("button", { name: "Close a visit" }).click();

    await page.waitForURL("**/app/visits");
    const total = page.locator(".visit-card-total");
    await expect(total).toContainText("MDL 650.00");
    await expect(total).toContainText("MDL 260.00");
    await context.close();
  });
});
