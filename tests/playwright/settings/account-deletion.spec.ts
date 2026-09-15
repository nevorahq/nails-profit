import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, type Studio } from "../helpers/studio";

/**
 * Which of two deletions comes first, said before the ritual rather than by the
 * refusal after it.
 *
 * An owner of a live studio is refused by `/api/v1/account/delete` with
 * `ORGANIZATION_PRESENT` — deleting them would leave an organization nobody can
 * reach and nobody can be promoted in. The endpoint keeps that rule; what
 * changed is that the screen no longer offers an action whose only possible
 * outcome is that refusal, discovered by typing your own address back and
 * pressing a red button.
 *
 * Both roles are checked, because the interesting half is what still works: a
 * master owns nothing, so nothing is orphaned by their leaving, and the action
 * has to stay exactly where it was for them.
 */
test.describe("leaving, from the settings screen", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("an owner is told the order instead of offered the refusal", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto("/app/settings");

    await expect(page.getByRole("button", { name: "Delete account" })).toHaveCount(0);
    await expect(
      page.getByText("The account can be deleted once the studio's data is gone"),
    ).toBeVisible();
    // Pointing at the section that comes first, rather than describing it.
    await expect(page.getByRole("link", { name: "Organization data" })).toHaveAttribute(
      "href",
      "#data-management-title",
    );
    await expect(page.locator("#data-management-title")).toBeVisible();

    await context.close();
  });

  test("a master, who owns nothing, still gets the action", async ({ browser, browserErrors }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();

    await page.goto("/app/settings");

    await expect(page.getByRole("button", { name: "Delete account" })).toBeVisible();
    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("heading", { name: "Delete account" })).toBeVisible();
    await expect(page.getByLabel("Your email address")).toBeVisible();

    await context.close();
  });
});
