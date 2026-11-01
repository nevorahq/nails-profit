import { expect, test } from "../fixtures";
import {
  chooseMaster,
  chooseService,
  disposeStudio,
  seedStudio,
  signedInContext,
  useClientAddress,
  type Studio,
} from "../helpers/studio";

/**
 * A master who charges their own price, from the card where it is set to the
 * page a client books on.
 *
 * The colleague charges 750 for the manicure the list prices at 600. Until a
 * master is picked the service says «from» the lower of the two; once one is,
 * it says theirs.
 */
test.describe("a master's own price", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("is set on the master's card", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    try {
      const page = await context.newPage();
      await page.goto(`/app/specialists/${studio.colleagueId}#services`);
      const row = page.locator(".specialist-service-row", { hasText: "Manicure with coating" });
      await row.getByRole("checkbox").check();
      // The list price is the hint, so an empty field reads as «the list's».
      await expect(row.getByLabel("Own price, MDL")).toHaveAttribute("placeholder", "600");
      await row.getByLabel("Own price, MDL").fill("750");
      const saved = page.waitForResponse(
        (response) => response.url().endsWith(`/specialists/${studio.colleagueId}/services`) && response.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "Save services" }).click();
      expect((await saved).status()).toBe(200);

      await page.reload();
      await expect(
        page.locator(".specialist-service-row", { hasText: "Manicure with coating" }).getByLabel("Own price, MDL"),
      ).toHaveValue("750");
    } finally {
      await context.close();
    }
  });

  test("is what the public page quotes once the master is picked", async ({ baseURL, page, browserErrors }) => {
    void browserErrors;
    await studio.owner.put(`/api/v1/specialists/${studio.colleagueId}/services`, {
      services: [{ service_id: studio.serviceId, price_minor: 75_000 }],
    });
    await useClientAddress(page, baseURL!);
    await page.goto(`/book/${studio.slug}`);

    const service = page.getByRole("combobox", { name: "Service" });
    await expect(service).toContainText("Manicure with coating — from MDL 600.00");

    await chooseService(page, studio.serviceId);
    await chooseMaster(page, studio.colleagueName);
    await expect(page.getByRole("combobox", { name: /^Service/ })).toContainText("Manicure with coating — MDL 750.00");
    await chooseMaster(page, studio.specialistName);
    await expect(page.getByRole("combobox", { name: /^Service/ })).toContainText("Manicure with coating — MDL 600.00");
  });
});
