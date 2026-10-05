import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * Materials per service, the way an owner turns them on.
 *
 * Settings → «Как считать материалы» → per service from this month; the field
 * appears on the service card and the amount comes off what the service
 * leaves; a visit closed afterwards carries it into the month's report, where
 * the reconciliation names it beside the purchases. At a desktop width and at
 * 375 px, where nothing may scroll sideways.
 */
for (const width of [null, 375] as const) {
  test.describe(`materials per service${width ? ` at ${width} px` : ""}`, () => {
    let studio: Studio;

    test.beforeAll(async ({ baseURL }, testInfo) => {
      studio = await seedStudio(baseURL!, testInfo);
    });

    test.afterAll(async () => {
      if (studio) await disposeStudio(studio);
    });

    test("are switched on in the settings, typed on the service and reconciled in the month", async ({
      baseURL,
      browser,
      browserErrors,
    }, testInfo) => {
      void browserErrors;
      const context = await signedInContext(browser, studio.owner, baseURL!);
      const page = await context.newPage();
      if (width) await page.setViewportSize({ width, height: 812 });
      const overflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      // Counting by purchases, the service card offers no field at all.
      await page.goto(`/app/services/${studio.serviceId}`);
      await expect(page.getByLabel("Materials per service, MDL")).toHaveCount(0);

      await page.goto("/app/settings");
      const block = page.locator("#materials-mode");
      await expect(block.getByText("Now: By purchases")).toBeVisible();
      await block.getByLabel("Method").selectOption("per_service");
      await block.getByRole("button", { name: "Save" }).click();
      await expect(block.getByText("Now: Per service")).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(0);

      await page.goto(`/app/services/${studio.serviceId}`);
      const field = page.getByLabel("Materials per service, MDL");
      await field.fill("35");
      await field.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
      await expect(page.locator(".metric-grid")).toContainText("Materials");
      await expect(field).toHaveValue("35");
      await page.screenshot({ path: testInfo.outputPath("service-materials.png"), fullPage: true });
      expect(await overflow()).toBeLessThanOrEqual(0);

      await studio.owner.post("/api/v1/visits", {
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
      });
      await page.goto("/app/reports/month");
      const reconciliation = page.locator("#materials-reconciliation");
      await expect(reconciliation).toContainText("Materials: used by the amounts on services");
      await expect(reconciliation).toContainText("35");
      await page.screenshot({ path: testInfo.outputPath("month-materials.png"), fullPage: true });
      expect(await overflow()).toBeLessThanOrEqual(0);

      await context.close();
    });
  });
}
