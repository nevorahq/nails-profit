import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  isoDate,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * Putting a face on a master's card.
 *
 * The parts this exercises exist nowhere else: `createImageBitmap`, a canvas
 * and `toBlob` run in a browser and in no test runner, and what they produce is
 * what the endpoint stores. A unit test can check the crop arithmetic and an
 * e2e test can check the endpoint; only this can check that the two meet — that
 * the file leaving the page is an image the server recognises, and that the
 * circle afterwards holds a photograph instead of a letter.
 *
 * It follows the picture out of the screen that sets it, too. The calendar's
 * day columns used to read `user.image` — the account's photo, which nothing
 * ever wrote — and the point of moving them to the card is that a face set here
 * is the face there.
 */
test.describe("a master's photo", () => {
  let studio: Studio;
  const day = daysFromToday(1);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    // The day view draws a column for a master who has something that day.
    await requestAppointmentAsClient(baseURL!, studio, { date: day });
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

    // The list is a list now: the name is the way into the card, and the photo
    // is set there rather than in a cell.
    const row = page.locator(".data-table tbody tr").filter({ hasText: studio.specialistName });
    await expect(row.locator(".specialist-photo .avatar")).toHaveText(
      studio.specialistName.slice(0, 1).toUpperCase(),
    );
    await row.getByRole("link", { name: studio.specialistName }).click();
    // `.app-header h1`, not `h1`: the topbar carries one of its own with the
    // section's name in it, on this page as on every other.
    await expect(page.locator(".app-header h1")).toHaveText(studio.specialistName);

    // The label is the control; the circle inside it is what a reader sees.
    const pick = page.locator(".specialist-photo-pick").first();
    const circle = pick.locator(".avatar");
    await expect(circle).toHaveText(studio.specialistName.slice(0, 1).toUpperCase());
    // It carries its own name, because nothing beside it does.
    await expect(pick).toHaveAccessibleName(/Add a photo/i);

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

    /*
     * Through the picture, not through the input behind it. `setInputFiles` on
     * the hidden control would upload just as well and would prove nothing
     * about the circle being the way to reach it — which is the whole of what
     * a reader is given here, there being no other control to press.
     */
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      pick.click(),
    ]);
    await chooser.setFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(wide) });

    const photo = circle.locator("img");
    await expect(pick).toHaveAccessibleName(/Replace the photo/i);
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute("src", /\/avatar\?v=\d+$/);

    // Squared and shrunk by the page, not merely displayed that way by CSS.
    const drawn = await photo.evaluate((image) => ({
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    }));
    expect(drawn.width).toBe(256);
    expect(drawn.height).toBe(256);

    /*
     * The picture is the only control in this panel, so the ring around it on
     * hover is the only thing that says so — and section 7.8 asks for a visible
     * focus state by name. Read from the computed style rather than from a
     * screenshot, which would pass on a ring nobody can see.
     */
    await pick.hover();
    expect(await circle.evaluate((el) => getComputedStyle(el).outlineWidth)).not.toBe("0px");

    const address = await photo.getAttribute("src");

    await page.goto(`/app/calendar?view=day&date=${isoDate(day)}`);
    const columnHead = page.locator(".calendar-column > h2");
    await expect(columnHead).toContainText(studio.specialistName);
    // The same address, so the calendar is reading the card rather than the
    // account behind it — and the browser has it cached already.
    await expect(columnHead.locator(".avatar img")).toHaveAttribute("src", address as string);

    await page.goBack();
    await page.getByRole("button", { name: /Remove the photo/i }).click();
    await expect(circle).toHaveText(studio.specialistName.slice(0, 1).toUpperCase());

    await page.goto(`/app/calendar?view=day&date=${isoDate(day)}`);
    await expect(page.locator(".calendar-column > h2 .avatar img")).toHaveCount(0);

    await context.close();
  });
});
