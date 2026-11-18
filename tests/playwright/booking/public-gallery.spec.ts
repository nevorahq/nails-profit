import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, useClientAddress, type Studio } from "../helpers/studio";

/**
 * The studio's finished work on its booking page, from both sides: a master
 * ticks the client's consent and shows a photo from the visit's card, and a
 * stranger on a phone sees it under the heading, opens it, and is taken on to
 * the form. Nothing is on the page before the studio says so.
 */
test.use({ viewport: { width: 375, height: 812 } });

test.describe("photos of work on the booking page", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL, page }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    await useClientAddress(page, baseURL!);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("published with the client's consent, seen and opened by a stranger, gone when taken down", async ({
    browser,
    baseURL,
    page,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const client = await studio.owner.post<{ id: string }>("/api/v1/clients", { name: "Pia Photo" });
    const visit = await studio.owner.post<{ id: string }>("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: studio.specialistId,
      client_id: client.id,
    });

    // Nothing to show yet: no heading, no strip.
    await page.goto(`/book/${studio.slug}`);
    await expect(page.getByRole("region", { name: "Our work" })).toHaveCount(0);

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const staff = await context.newPage();
    await staff.goto(`/app/visits?visit=${visit.id}`);
    const photos = staff.getByRole("region", { name: "Photos of the work" });

    const jpeg = await staff.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1200;
      const context2d = canvas.getContext("2d")!;
      context2d.fillStyle = "#c58b9b";
      context2d.fillRect(0, 0, 1600, 1200);
      return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    });
    await photos
      .locator('input[type="file"]')
      .setInputFiles({ name: "work.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") });
    await expect(photos.locator(".visit-photos-grid img")).toHaveCount(1);

    // Publishing is not possible until the client's consent is ticked.
    await photos.getByRole("button", { name: "Show photo 1 to clients" }).click();
    const publish = photos.getByRole("button", { name: "Publish" });
    await expect(publish).toBeDisabled();
    await photos.getByLabel(/The client agrees/).check();
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(photos.getByText("On the booking page")).toBeVisible();
    await staff.screenshot({ path: testInfo.outputPath("visit-published-375.png"), fullPage: true });

    // The stranger's side.
    await page.goto(`/book/${studio.slug}`);
    const gallery = page.getByRole("region", { name: "Our work" });
    const tile = gallery.getByRole("button", { name: "Open work 1" });
    await expect(tile).toBeVisible();
    await expect
      .poll(() => tile.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: testInfo.outputPath("book-gallery-375.png"), fullPage: false });

    await tile.click();
    const dialog = page.getByRole("dialog", { name: "Our work" });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("book-gallery-dialog-375.png") });
    await dialog.getByRole("button", { name: /^Book with / }).click();
    await expect(dialog).toBeHidden();

    // Taken down, it is off the page.
    await staff.reload();
    await photos.getByRole("button", { name: "Remove photo 1 from the booking page" }).click();
    await expect(photos.getByText("On the booking page")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("region", { name: "Our work" })).toHaveCount(0);
    await context.close();
  });
});
