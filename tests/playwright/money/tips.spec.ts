import { expect, test } from "../fixtures";
import {
  bookAppointment,
  daysFromToday,
  disposeStudio,
  isoDate,
  moveIntoThePast,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/**
 * «Чаевые» on the three screens that close or correct a visit.
 *
 * Canonical studio: a 600 MDL service at 40%. A 50 MDL tip must reach the visit
 * list as a tip beside the earnings — the total still 600, the master's 240 —
 * because it is the master's money and not the studio's revenue.
 */
for (const width of [null, 375] as const) {
  test.describe(`tips${width ? ` at ${width} px` : ""}`, () => {
    let studio: Studio;
    if (width) test.use({ viewport: { width, height: 812 } });

    test.beforeEach(async ({ baseURL }, testInfo) => {
      studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    });

    test.afterEach(async () => {
      if (studio) await disposeStudio(studio);
    });

    test("a tip left on closing a visit is shown beside the earnings, not in the revenue", async (
      { browser, baseURL, browserErrors },
      testInfo,
    ) => {
      void browserErrors;
      const context = await signedInContext(browser, studio.owner, baseURL!);
      const page = await context.newPage();
      await page.goto("/app/visits/new");

      const tip = page.getByLabel("Tip, MDL");
      await expect(tip).toHaveValue("");
      await expect(page.locator("main")).toContainText("Not part of the revenue");
      await tip.fill("5x");
      await expect(page.getByRole("button", { name: "Close a visit" })).toBeDisabled();
      await tip.fill("50");
      await page.screenshot({ path: testInfo.outputPath("close-form-tip.png"), fullPage: true });
      await page.getByRole("button", { name: "Close a visit" }).click();

      await page.waitForURL("**/app/visits");
      const total = page.locator(".visit-card-total");
      await expect(total).toContainText("MDL 600.00");
      await expect(total).toContainText("MDL 240.00");
      await expect(total).toContainText("Tips: MDL 50.00");

      // Corrected the next day: the field opens on what is there.
      await page.locator(".visit-card summary").first().click();
      await page.locator(".visit-card").first().getByText("Duration, refund or tip").click();
      const later = page.locator(".visit-card").first().getByLabel("Tip, MDL");
      await expect(later).toHaveValue("50");
      // Open, the correction stays inside the card on the narrowest screen.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await later.fill("80");
      await page.locator(".visit-card").first().getByRole("button", { name: "Save" }).click();
      await expect(total).toContainText("Tips: MDL 80.00");
      await expect(total).toContainText("MDL 600.00");
      await context.close();
    });

    test("a tip left when an appointment is closed from the calendar", async (
      { browser, baseURL, browserErrors },
    ) => {
      void browserErrors;
      const booking = await bookAppointment(studio.owner, studio, { startsAt: daysFromToday(1) });
      const startsAt = await moveIntoThePast(studio, booking.id);

      const context = await signedInContext(browser, studio.owner, baseURL!);
      const page = await context.newPage();
      await page.goto(`/app/calendar?date=${isoDate(startsAt)}&specialist=${studio.specialistId}&booking=${booking.id}`);

      const entry = page.locator(`#booking-${booking.id}`);
      await entry.getByLabel("Tip, MDL").fill("30");
      await entry
        .locator("details.calendar-subform form")
        .getByRole("button", { name: "Close into a visit" })
        .click();
      await expect(entry).toContainText("Completed");

      await page.goto("/app/visits");
      const total = page.locator(".visit-card-total");
      await expect(total).toContainText("MDL 600.00");
      await expect(total).toContainText("Tips: MDL 30.00");
      await context.close();
    });
  });
}
