import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, type Studio } from "../helpers/studio";

/**
 * Putting a face on a master's card.
 *
 * The parts this exercises exist nowhere else: `createImageBitmap`, a canvas
 * and `toBlob` run in a browser and in no test runner, and what they produce is
 * what the endpoint stores. A unit test can check the crop arithmetic and an
 * e2e test can check the endpoint; only this can check that the two meet — that
 * the file leaving the page is an image the server recognises, and that the
 * circle afterwards holds a photograph instead of a letter.
 */
test.describe("a master's photo", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("uploads, replaces the initial, and can be taken off again", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto("/app/specialists");

    const row = page.locator(".data-table tbody tr").filter({ hasText: studio.specialistName });
    const circle = row.locator(".specialist-photo .avatar").first();
    await expect(circle).toHaveText(studio.specialistName.slice(0, 1).toUpperCase());

    // A 600×200 landscape PNG, so the crop has something to do: what is stored
    // must come back square.
    const wide = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 200;
      const context2d = canvas.getContext("2d")!;
      context2d.fillStyle = "#7a5c3e";
      context2d.fillRect(0, 0, 600, 200);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      const bytes = new Uint8Array(await blob!.arrayBuffer());
      return Array.from(bytes);
    });

    await row
      .locator('input[type="file"]')
      .setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(wide) });

    const photo = circle.locator("img");
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute("src", /\/avatar\?v=\d+$/);

    // Squared and shrunk by the page, not merely displayed that way by CSS.
    const drawn = await photo.evaluate((image) => ({
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    }));
    expect(drawn.width).toBe(256);
    expect(drawn.height).toBe(256);

    await row.getByRole("button", { name: /Remove the photo/i }).click();
    await expect(circle).toHaveText(studio.specialistName.slice(0, 1).toUpperCase());

    await context.close();
  });
});
