import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, useClientAddress, type Studio } from "../helpers/studio";

/**
 * Where the studio is, shown without leaving the booking page.
 *
 * A button under the studio's name opens Google's map for the address of the
 * chosen location, as written — no key, no stored coordinates.
 * A location with no address has nothing to look up, so it gets no button.
 */
for (const width of [null, 375] as const) {
  test.describe(`the map on the public page${width ? ` at ${width} px` : ""}`, () => {
    let studio: Studio;
    if (width) test.use({ viewport: { width, height: 812 } });

    test.beforeEach(async ({ baseURL, page }, testInfo) => {
      studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
      await useClientAddress(page, baseURL!);
      // The map itself is Google's; what is tested here is what is asked of it.
      await page.route("https://www.google.com/maps**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<p>map</p>" }),
      );
    });

    test.afterEach(async () => {
      if (studio) await disposeStudio(studio);
    });

    test("shows the address and opens a map for it", async ({ page, browserErrors }, testInfo) => {
      void browserErrors;
      await page.goto(`/book/${studio.slug}`);
      // The button is all the header says; the address is in the window.
      await expect(page.locator(".public-booking-header")).not.toContainText("10 Test Street");

      await page.screenshot({ path: testInfo.outputPath("public-header.png") });

      await page.getByRole("button", { name: "Address on the map" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("10 Test Street");
      await expect(dialog.locator("iframe")).toHaveAttribute("src", /maps\?q=10%20Test%20Street&hl=en&output=embed$/);
      await expect(dialog.getByRole("link", { name: "Open in Google Maps" })).toHaveAttribute(
        "href",
        "https://www.google.com/maps/search/?api=1&query=10%20Test%20Street",
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath("public-map.png") });

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      await page.getByRole("button", { name: "Address on the map" }).click();
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toHaveCount(0);
    });

    test("has no map button when the location has no address", async ({ page, browserErrors }) => {
      void browserErrors;
      await studio.owner.patch(`/api/v1/locations/${studio.locationId}`, { address: null });
      await page.goto(`/book/${studio.slug}`);
      await expect(page.getByRole("combobox", { name: "Service" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Address on the map" })).toHaveCount(0);
    });
  });
}
