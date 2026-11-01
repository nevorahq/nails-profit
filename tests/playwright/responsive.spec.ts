import { expect, test } from "./fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "./helpers/studio";

/**
 * One screen, three widths: a phone, a tablet held upright, a laptop.
 *
 * The stylesheet is written in `rem` and the root size is the scale, which used
 * to be `100vw / 1920` from 640px up — so a 768 tablet drew 16rem text at 6px
 * and a 1280 laptop at 10.7px, and the tables spilled past the screen at the
 * one width between the phone rules and the desktop ones. Both are properties
 * of the whole stylesheet rather than of a screen, so they are asserted here
 * once over the screens that carry the most: the report, the calendar, the two
 * lists with a table, the settings, and the public booking page.
 */
const WIDTHS = [
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
] as const;

const OWNER_PAGES = [
  "/app",
  "/app/calendar",
  "/app/clients",
  "/app/services",
  "/app/specialists",
  "/app/reports/services",
  "/app/booking",
  "/app/settings",
] as const;

async function sidewaysOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("responsive", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  for (const { name, width, height } of WIDTHS) {
    test(`the application does not scroll sideways on a ${name} (${width}px)`, async ({
      baseURL,
      browser,
      browserErrors,
    }) => {
      void browserErrors;
      const context = await signedInContext(browser, studio.owner, baseURL!);
      const page = await context.newPage();
      await page.setViewportSize({ width, height });

      for (const path of OWNER_PAGES) {
        await page.goto(path);
        await expect(page.locator("h1.topbar-title")).toBeVisible();
        expect(await sidewaysOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
      }
      await context.close();
    });

    test(`the public booking page fits a ${name} (${width}px)`, async ({ page, browserErrors }) => {
      void browserErrors;
      await page.setViewportSize({ width, height });
      await page.goto(`/book/${studio.slug}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test("a tablet is not drawn at a fraction of a phone's size", async ({ page, browserErrors }) => {
    void browserErrors;
    const rootSize = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

    // 1rem is a pixel at the smallest width the desktop layouts run at, and
    // never less: that is what keeps 16rem body text at 16px and the 10rem
    // labels readable.
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/");
    expect(await rootSize()).toBeGreaterThanOrEqual(1);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    expect(await rootSize()).toBeGreaterThanOrEqual(1);

    // A phone keeps the 1/390 scale the screens were drawn at.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    expect(await rootSize()).toBeCloseTo(1, 1);
  });
});
