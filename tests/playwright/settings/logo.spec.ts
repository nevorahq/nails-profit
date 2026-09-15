import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, type Studio } from "../helpers/studio";

/**
 * Putting the studio's own mark where the product's flower stands.
 *
 * What only a browser can show: the picture is squared and re-encoded by a
 * canvas on the way out of this page, and the topbar that draws the result is
 * rendered by the layout above it rather than by the settings screen — so a
 * mark that appears in the preview and nowhere else would look entirely correct
 * to every other kind of test here.
 *
 * The flower is the other half of the claim. It is what stands there before a
 * logo exists and what has to come back the moment one is removed; a studio is
 * never left with an empty square, which is the reason there is no "no logo"
 * state to draw at all.
 */
test.describe("the studio's logo", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("replaces the flower in the topbar, and gives it back when removed", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto("/app/settings");

    const preview = page.locator(".studio-logo-preview");
    const brand = page.locator(".topbar-brand");
    // The same component in both places, which is what makes the preview a
    // preview rather than an illustration of one.
    await expect(preview.locator("svg.brand-mark")).toBeVisible();
    await expect(brand.locator("svg.brand-mark")).toBeVisible();
    await expect(brand.locator("img.brand-logo")).toHaveCount(0);

    const pick = page.locator("label.secondary-button").filter({ hasText: /Upload a logo/i });
    await expect(pick).toBeVisible();
    // Nothing to remove yet, so nothing offers to.
    await expect(page.getByRole("button", { name: /Remove the logo/i })).toHaveCount(0);

    // A 600×200 landscape PNG, so the crop has something to do: what comes back
    // must be square.
    const wide = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 200;
      const context2d = canvas.getContext("2d")!;
      context2d.fillStyle = "#7a5c3e";
      context2d.fillRect(0, 0, 600, 200);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      return Array.from(new Uint8Array(await blob!.arrayBuffer()));
    });

    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pick.click()]);
    await chooser.setFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(wide) });

    const drawn = preview.locator("img");
    await expect(drawn).toBeVisible();
    await expect(drawn).toHaveAttribute("src", /\/api\/v1\/organizations\/logo\?v=\d+$/);
    // The label says what the control does now that there is something to replace.
    await expect(page.locator("label.secondary-button").filter({ hasText: /Replace the logo/i })).toBeVisible();

    /*
     * Squared and shrunk by the page, not merely displayed that way by CSS.
     * Polled rather than read once: the attribute is set the moment the server
     * answers, and under a parallel run the bytes are not decoded yet — which
     * is exactly the race that makes the master's photo spec flap.
     */
    await expect
      .poll(async () => drawn.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBe(256);
    expect(await drawn.evaluate((image) => (image as HTMLImageElement).naturalHeight)).toBe(256);

    const address = (await drawn.getAttribute("src")) as string;
    // The mark is in the corner of the screen the owner is already looking at,
    // reading the same address the preview does.
    await expect(brand.locator("img.brand-logo")).toHaveAttribute("src", address);
    await expect(brand.locator("svg.brand-mark")).toHaveCount(0);

    // And on every other screen, because it is the layout that draws it.
    await page.goto("/app/clients");
    await expect(page.locator(".topbar-brand img.brand-logo")).toHaveAttribute("src", address);

    await page.goto("/app/settings");
    await page.getByRole("button", { name: /Remove the logo/i }).click();

    // The flower is back in both places at once: there is no state in between.
    await expect(preview.locator("svg.brand-mark")).toBeVisible();
    await expect(preview.locator("img")).toHaveCount(0);
    await expect(brand.locator("svg.brand-mark")).toBeVisible();
    await expect(brand.locator("img.brand-logo")).toHaveCount(0);

    await context.close();
  });
});
