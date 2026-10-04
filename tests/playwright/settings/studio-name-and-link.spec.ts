import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * The studio's name and its booking link, changed from the screens an owner
 * actually opens.
 *
 * Sign-up derives the link from the name, and afterwards nothing could change
 * either: `/app/booking` showed «/book/some-one» with no control beside it, and
 * the «Name» on the address card below — prefilled with the studio's own
 * name — renamed only that address. Each test seeds its own studio, because
 * each one moves the link the next would be looking for.
 */
test.describe("the studio's name and booking link", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("the link is moved from «Online booking», and the old one stops answering", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    const moved = `${studio.slug.slice(0, 34)}-moved`;

    await page.goto("/app/booking");
    await expect(page.getByRole("link", { name: `/book/${studio.slug}` })).toBeVisible();

    await page.getByRole("button", { name: "Change the link" }).click();
    // Said before the save, because after it the old link is already gone.
    await expect(page.getByText("The old link will stop working")).toBeVisible();
    await page.getByLabel("Link address").fill(moved);
    await page.getByRole("button", { name: "Save the link" }).click();

    await expect(page.getByRole("link", { name: `/book/${moved}` })).toBeVisible();
    expect((await page.request.get(`/book/${moved}`)).status()).toBe(200);
    expect((await page.request.get(`/book/${studio.slug}`)).status()).toBe(404);

    await context.close();
  });

  test("a reserved word is refused in words before anything is sent", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/booking");
    await page.getByRole("button", { name: "Change the link" }).click();
    await page.getByLabel("Link address").fill("admin");
    await page.getByRole("button", { name: "Save the link" }).click();

    // By its class: Next.js's route announcer is an `alert` too.
    await expect(page.locator(".form-error")).toHaveText(/reserved/);
    expect((await page.request.get(`/book/${studio.slug}`)).status()).toBe(200);

    await context.close();
  });

  test("renaming the studio is reached from the address card and offers the link to follow", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    const word = `belle${Math.floor(Math.random() * 1e6)}`;

    await page.goto("/app/booking");
    // Two addresses: the one registration wrote under the studio's own name,
    // and the fixture's «Central». The second is the one that cannot be
    // mistaken for the studio.
    const card = page.locator("details", { hasText: "Central —" });
    await card.locator("summary").click();
    // The card's field is the address's own name, and says so.
    await expect(card.getByLabel("Address name")).toHaveValue("Central");
    await expect(card.getByText("It does not change the studio name or the link.")).toBeVisible();

    await card.getByRole("link", { name: "Rename the studio" }).click();
    await expect(page).toHaveURL(/\/app\/settings\?edit=name/);

    // Unfolded on arrival: the link pointed at the name, not at a closed panel.
    await page.getByLabel("Studio name").fill(`Studio ${word}`);
    await page.getByRole("button", { name: "Save the name" }).click();

    await expect(page.getByText(`The booking link is still /book/${studio.slug}`)).toBeVisible();
    await expect(page.getByLabel("Link address")).toHaveValue(`studio-${word}`);
    await page.getByRole("button", { name: "Save the link" }).click();

    await expect(page.getByLabel("Link address")).toHaveCount(0);
    expect((await page.request.get(`/book/studio-${word}`)).status()).toBe(200);
    // What a client reads on the moved page is the new name.
    const profile = (await (
      await page.request.get(`/api/v1/public/booking/studio-${word}`)
    ).json()) as { data: { name: string } };
    expect(profile.data.name).toBe(`Studio ${word}`);

    await context.close();
  });

  test("a new address is added by its name alone", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/booking");
    // «Address in the link» promised to go into a link it never reached; the
    // address is keyed by its name on the server instead.
    await expect(page.getByLabel("Address in the link")).toHaveCount(0);

    const form = page.locator("form", { has: page.getByRole("button", { name: "Add an address" }) });
    await form.getByLabel("Address name").fill("Botanica");
    await form.getByRole("button", { name: "Add an address" }).click();

    await expect(page.getByText("Botanica —")).toBeVisible();
    // The booking link is the studio's, and adding an address does not move it.
    await expect(page.getByRole("link", { name: `/book/${studio.slug}` })).toBeVisible();

    await context.close();
  });
});
