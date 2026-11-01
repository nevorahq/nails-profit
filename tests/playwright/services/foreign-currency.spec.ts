import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * A service in another currency than its studio's is not offered on the booking
 * page, and used to say nothing about it: in the catalogue it looked like any
 * other row. The row and the page of the service now say what clients will miss.
 */
test.describe("a service in another currency than the studio's", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("is marked in the catalogue and on its own page", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const abroad = await studio.owner.post<{ id: string }>("/api/v1/services", {
      name: { en: "Foreign gel", ru: "Иностранный гель" },
      price_minor: 20_000,
      duration_minutes: 60,
      currency: "EUR",
    });

    const context = await signedInContext(browser, studio.owner, baseURL!);
    try {
      const page = await context.newPage();
      await page.goto("/app/services");
      const note = "The service is in EUR and the studio in MDL: clients will not see it when booking online.";
      await expect(page.locator(".service-foreign-currency")).toHaveText([note]);
      // The studio's own services carry no note.
      await expect(page.getByRole("row", { name: /Manicure with coating/ }).locator(".service-foreign-currency")).toHaveCount(0);

      await page.goto(`/app/services/${abroad.id}`);
      await expect(page.getByRole("status").filter({ hasText: note })).toBeVisible();

      // The booking page does not offer it while it is in another currency…
      const offered = async () =>
        (
          (await (
            await page.request.get(`/api/v1/public/booking/${studio.slug}/catalog?location_id=${studio.locationId}`)
          ).json()) as { data: { services: { name: string }[] } }
        ).data.services.map((entry) => entry.name);
      expect(await offered()).not.toContain("Foreign gel");

      // …and one press records it in the studio's currency, the price as it was.
      await page.getByRole("button", { name: "Record in MDL, same price" }).click();
      await expect(page.getByRole("status").filter({ hasText: note })).toHaveCount(0);
      await expect(page.getByLabel("Price, MDL")).toHaveValue("200");
      expect(await offered()).toContain("Foreign gel");
    } finally {
      await context.close();
    }
  });
});
