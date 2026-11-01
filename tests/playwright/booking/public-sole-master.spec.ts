import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  seedStudio,
  useClientAddress,
  type Studio,
  chooseMaster,
  chooseRibbonDay,
  chooseService,
  serviceCards,
} from "../helpers/studio";

/**
 * A studio where one pair of hands does everything.
 *
 * An owner working under their own name beside a studio called something else
 * is still a master the client picks: the page asks the same two questions in
 * the same order whoever works there, and names them beside the time held.
 * Only when the master is the studio's own name is there no question at all,
 * and the page goes from the service to the price and the days.
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

    test("asks for the master even when there is one", async ({ page, browserErrors }, testInfo) => {
      void browserErrors;
      await page.goto(`/book/${studio.slug}`);
      await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
      await expect(page.locator(".public-booking-master-name")).toHaveText([studio.specialistName]);
      // Nothing below the master until there is one: no services, no days.
      await expect(serviceCards(page)).toHaveCount(0);
      await expect(page.locator(".public-booking-days-strip")).toHaveCount(0);

      await chooseMaster(page, studio.specialistName);
      await expect(serviceCards(page)).toBeVisible();
      await expect(page.locator(".public-booking-days-strip")).toHaveCount(0);
      await chooseService(page, studio.serviceId);
      await expect(page.locator(".public-booking-days-strip button:not(:disabled)").first()).toBeVisible();

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

    test("keeps the master picked while a service is chosen", async ({ page, browserErrors }) => {
      void browserErrors;
      await page.goto(`/book/${studio.slug}`);
      await chooseMaster(page, studio.specialistName);
      await expect(page.getByRole("radio", { checked: true })).toHaveValue(studio.specialistId);
      await expect(page.locator(".public-booking-days-strip")).toHaveCount(0);

      await chooseService(page, studio.serviceId);
      await expect(page.getByRole("radio", { checked: true })).toHaveValue(studio.specialistId);
      await expect(page.locator(".public-booking-days-strip button:not(:disabled)").first()).toBeVisible();
    });

    test("asks nothing about the master when it is the studio's own name", async ({ page, browserErrors }) => {
      void browserErrors;
      await page.goto(`/book/${studio.slug}`);
      const studioName = (await page.locator(".public-booking-header .brand").textContent())!.trim();
      await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { name: studioName });

      await page.reload();
      await expect(serviceCards(page)).toBeVisible();
      await expect(page.getByRole("group", { name: "Specialist" })).toHaveCount(0);
      await expect(page.locator(".public-booking-days-strip")).toHaveCount(0);
      await chooseService(page, studio.serviceId);
      await expect(page.getByRole("group", { name: "Specialist" })).toHaveCount(0);
      await expect(page.locator(".public-booking-days-strip button:not(:disabled)").first()).toBeVisible();

      await chooseRibbonDay(page, daysFromToday(2));
      await page.locator(".public-booking-slots button").first().click();
      await expect(page.locator(".public-booking-summary")).toContainText("Date and time");
    });
  });
}
