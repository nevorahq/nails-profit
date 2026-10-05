import { expect, test } from "./fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "./helpers/studio";

/**
 * A compose panel named in the address opens on a full page load.
 *
 * Five screens fold their add form away and open it when the address ends in
 * its anchor — the header's own button, the onboarding steps, the phone's «+»,
 * a bookmark. Reached by a client-side link the panel opened; reached by
 * typing the address, reloading or following it from outside the app, it stayed
 * shut, because the hash was read during hydration and the server had already
 * drawn the panel closed.
 */
const PANELS = [
  ["/app/expenses", "add-expense"],
  ["/app/services", "add-service"],
  ["/app/clients", "add-client"],
  ["/app/specialists", "add-specialist"],
  ["/app/import", "import-upload"],
] as const;

test.describe("a compose panel opened by its address", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  for (const [path, anchor] of PANELS) {
    test(`opens ${path}#${anchor} on a full page load, and closes from the header`, async ({
      baseURL,
      browser,
      browserErrors,
    }) => {
      void browserErrors;
      const context = await signedInContext(browser, studio.owner, baseURL!);
      const page = await context.newPage();

      await page.goto(`${path}#${anchor}`);
      const panel = page.locator(`#${anchor}`);
      await expect(panel).not.toHaveClass(/is-closed/);
      await expect(panel.locator("input, select").first()).toBeVisible();

      // The header's control is the same toggle it is on a page opened without
      // the anchor: one press folds the panel the address opened.
      await page.locator(`a[href="#${anchor}"]`).filter({ visible: true }).first().click();
      await expect(panel).toHaveClass(/is-closed/);

      // And an address without the anchor still opens on the panel folded.
      await page.goto(path);
      await expect(page.locator(`#${anchor}`)).toHaveClass(/is-closed/);
      await context.close();
    });
  }
});
