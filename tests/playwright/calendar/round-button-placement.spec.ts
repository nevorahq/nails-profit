import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio, untilRevealed } from "../helpers/studio";

/**
 * The round «+» on a phone: centred on the screen, with its own centre on the
 * top edge of the bottom bar — half of it on the bar, half above.
 *
 * The owner's is the shell's (`.quick-actions-toggle`), everyone else's is the
 * calendar's own (`.calendar-fab`); they are two elements in one place, so the
 * same measurement holds for both. It is a measurement rather than a
 * screenshot because what can go wrong is a unit: the bar's height drifting from
 * the number the button is placed by.
 */
test.describe("the round button on the bar", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  for (const who of ["owner", "master"] as const) {
    test(`is centred on the bar's top edge for the ${who}`, async ({ baseURL, browser, browserErrors }) => {
      void browserErrors;
      const context = await signedInContext(browser, studio[who], baseURL!);
      const page = await context.newPage();
      test.skip((page.viewportSize()?.width ?? 0) > 680, "the bar and this button are the phone's");
      await page.goto("/app/calendar");
      // Boxes are measured below, and a box is null while the page is behind its skeleton.
      await untilRevealed(page);

      const button = page.locator(who === "owner" ? ".quick-actions-toggle" : ".calendar-fab");
      await expect(button).toBeVisible();

      const bar = (await page.locator(".bottom-nav").boundingBox())!;
      const round = (await button.boundingBox())!;
      const width = page.viewportSize()!.width;

      expect(round.x + round.width / 2).toBeCloseTo(width / 2, 0);
      expect(round.y + round.height / 2).toBeCloseTo(bar.y, 0);
      await context.close();
    });
  }

  for (const who of ["owner", "master"] as const) {
    test(`leaves the button room between the middle tabs for the ${who}`, async ({
      baseURL,
      browser,
      browserErrors,
    }) => {
      void browserErrors;
      const context = await signedInContext(browser, studio[who], baseURL!);
      const page = await context.newPage();
      test.skip((page.viewportSize()?.width ?? 0) > 680, "the bar and this button are the phone's");
      await page.goto("/app/calendar");
      // Boxes are measured below, and a box is null while the page is behind its skeleton.
      await untilRevealed(page);

      const button = (await page.locator(who === "owner" ? ".quick-actions-toggle" : ".calendar-fab").boundingBox())!;
      const tabs = page.locator(".bottom-nav li");
      await expect(tabs).toHaveCount(4);
      const [first, second, third, fourth] = await Promise.all(
        [0, 1, 2, 3].map(async (index) => (await tabs.nth(index).boundingBox())!),
      );

      // The seam in the middle is the button's column, with air on both sides.
      expect(third.x - (second.x + second.width)).toBeGreaterThanOrEqual(button.width);
      // And the first and second stand closer than the second and third.
      expect(second.x - first.x).toBeLessThan(third.x - second.x);
      // Mirrored: the outer two alike, the inner two alike.
      expect(first.width).toBeCloseTo(fourth.width, 0);
      expect(second.width).toBeCloseTo(third.width, 0);
      // Nothing of the button over either middle tab.
      expect(second.x + second.width).toBeLessThanOrEqual(button.x);
      expect(third.x).toBeGreaterThanOrEqual(button.x + button.width);
      await context.close();
    });
  }

  test("opens its menu centred over the button", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    test.skip((page.viewportSize()?.width ?? 0) > 680, "the bar and this button are the phone's");
    await page.goto("/app/calendar");
    await untilRevealed(page);

    await page.locator(".quick-actions-toggle").click();
    const menu = (await page.locator(".quick-actions-menu").boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(menu.x + menu.width / 2).toBeCloseTo(width / 2, 0);
    await context.close();
  });

  test("rounds its items and drops them out last-first", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    test.skip((page.viewportSize()?.width ?? 0) > 680, "the bar and this button are the phone's");
    // The suite runs with reduced motion, which switches every animation off.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/app/calendar");
    await untilRevealed(page);

    await page.locator(".quick-actions-toggle").click();
    const items =page.locator(".quick-actions-menu li");
    const count = await items.count();
    expect(count).toBeGreaterThan(1);

    const radius = await page
      .locator(".quick-actions-menu a")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(radius).toBeGreaterThanOrEqual(10);

    // The last item is nearest the button and goes first; each one above waits longer.
    const delays = await items.evaluateAll((els) =>
      els.map((el) => parseFloat(getComputedStyle(el).animationDelay)),
    );
    expect(delays[count - 1]).toBe(0);
    for (let i = count - 1; i > 0; i--) expect(delays[i - 1]).toBeGreaterThan(delays[i]);
    await context.close();
  });
});
