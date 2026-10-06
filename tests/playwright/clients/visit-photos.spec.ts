import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * Photos of work, on a phone: a photo taken with the camera is shrunk in the
 * browser, kept, shown on the visit's card and on the client's, and removed.
 *
 * At 375 px, because the photo is taken there and then, with the phone in the
 * master's hand.
 */
test.use({ viewport: { width: 375, height: 812 } });

test.describe("photos of the work at a visit", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("add a photo from the phone, see it on the visit and the client, and remove it", async ({
    browser,
    baseURL,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const client = await studio.owner.post<{ id: string }>("/api/v1/clients", { name: "Pia Photo" });
    const visit = await studio.owner.post<{ id: string }>("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: studio.specialistId,
      client_id: client.id,
    });

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`/app/visits?visit=${visit.id}`);
    const photos = page.getByRole("region", { name: "Photos of the work" });
    await expect(photos).toContainText("0 of 4");

    // A phone-sized photograph, made in the page: 4032 × 3024, as a camera takes it.
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 4032;
      canvas.height = 3024;
      const context = canvas.getContext("2d")!;
      const gradient = context.createLinearGradient(0, 0, 4032, 3024);
      gradient.addColorStop(0, "#c58b9b");
      gradient.addColorStop(1, "#3f5e4b");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 4032, 3024);
      return canvas.toDataURL("image/jpeg", 0.95).split(",")[1];
    });
    await photos
      .locator('input[type="file"]')
      .setInputFiles({ name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") });

    const thumbnail = photos.locator(".visit-photos-grid img");
    await expect(thumbnail).toHaveCount(1);
    await expect(photos).toContainText("1 of 4");
    // Loaded through the application's own address, not merely placed.
    await expect
      .poll(() => thumbnail.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBe(1280);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: testInfo.outputPath("visit-photo-375.png"), fullPage: true });

    const stored = await studio.owner.get<{ photos: { width: number; height: number }[] }>(
      `/api/v1/visits/${visit.id}/photos`,
    );
    expect(stored.photos).toEqual([expect.objectContaining({ width: 1280, height: 960 })]);

    await page.goto(`/app/clients/${client.id}`);
    await expect(page.getByRole("heading", { name: "Recent work" })).toBeVisible();
    await expect(page.locator(".visit-photos-grid img")).toHaveCount(1);

    await page.goto(`/app/visits?visit=${visit.id}`);
    await photos.getByRole("button", { name: "Remove photo 1" }).click();
    await expect(photos.locator(".visit-photos-grid img")).toHaveCount(0);
    await expect(photos).toContainText("0 of 4");

    expect(errors).toEqual([]);
    await context.close();
  });
});
