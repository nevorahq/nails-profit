import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  seedStudio,
  useClientAddress,
  type Studio,
  chooseRibbonDay,
} from "../helpers/studio";

/**
 * A studio where one pair of hands does everything — an owner working under
 * their own name beside a studio called something else.
 *
 * There is nothing to choose, so no list; but who will do the nails is still
 * news to the client, and the page says it above the date and beside the time
 * held. Only when the master is the studio's own name is it left out.
 */
for (const width of [null, 375] as const) {
  test.describe(`the public page with one master${width ? ` at ${width} px` : ""}`, () => {
    let studio: Studio;
    if (width) test.use({ viewport: { width, height: 812 } });

    test.beforeEach(async ({ baseURL, page }, testInfo) => {
      studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
      // The colleague leaves the location: the master is the only one left.
      await studio.owner.put(`/api/v1/specialists/${studio.colleagueId}/locations`, { location_ids: [] });
      await useClientAddress(page, baseURL!);
    });

    test.afterEach(async () => {
      if (studio) await disposeStudio(studio);
    });

    test("names the master instead of offering a choice of one", async ({ page, browserErrors }, testInfo) => {
      void browserErrors;
      await page.goto(`/book/${studio.slug}`);
      const master = page.locator(".public-booking-master");
      await expect(master).toContainText("Specialist");
      await expect(master).toContainText(studio.specialistName);
      await expect(page.getByRole("combobox", { name: "Specialist" })).toHaveCount(0);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath("public-sole-master.png"), fullPage: true });

      await chooseRibbonDay(page, daysFromToday(2));
      const times = page.locator(".public-booking-slots button");
      await expect(times.first()).toBeVisible();
      // One name, said once: not under every time.
      await expect(times.first()).not.toContainText(studio.specialistName);
      await times.first().click();

      await expect(page.locator(".public-booking-summary")).toContainText(studio.specialistName);
    });

    test("leaves the name out when it is the studio's own", async ({ page, browserErrors }) => {
      void browserErrors;
      await page.goto(`/book/${studio.slug}`);
      const studioName = (await page.locator(".public-booking-header .brand").textContent())!.trim();
      await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { name: studioName });

      await page.reload();
      await expect(page.locator(".public-booking-days-strip")).toBeVisible();
      await expect(page.locator(".public-booking-master")).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Specialist" })).toHaveCount(0);

      await chooseRibbonDay(page, daysFromToday(2));
      await page.locator(".public-booking-slots button").first().click();
      await expect(page.locator(".public-booking-summary")).toContainText("Date and time");
    });
  });
}
