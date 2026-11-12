import type { Route } from "@playwright/test";

import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * A click on a section answers before the section's data does.
 *
 * Every page under /app reads the database first, and in production the
 * database is in another region: a page is one to three seconds away. Before
 * `app/app/loading.tsx` existed, Next did not prefetch those pages at all, and a
 * click left the old screen, the old address and the old lit link in place until
 * the whole new page had arrived — a click that looked as if it had not
 * registered.
 *
 * So the test holds the page's own request back and asserts what the person
 * sees while it is held: the new address and the skeleton. Only against a
 * production build, because Next prefetches only there; `next dev`, which a
 * local run starts, would wait for the held request whatever the code did. CI
 * builds, and a local run can too: `CI=1 npm run test:playwright -- …`.
 */
test.describe("navigation feedback", () => {
  test.skip(!process.env.CI && !process.env.PLAYWRIGHT_BASE_URL, "prefetching runs only in a production build");

  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("a section shows its skeleton and address at once while its data is on the way", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/settings");
    await expect(page.locator("h1.topbar-title")).toHaveText("Settings");
    // The links on screen are prefetched once the page is idle; that prefetch
    // is what carries the skeleton, so it has to have happened first.
    await page.waitForLoadState("networkidle");

    let held: Route | null = null;
    await page.route(
      (url) => url.pathname === "/app/calendar",
      async (route) => {
        const headers = route.request().headers();
        const prefetch = headers["next-router-prefetch"] || headers["next-router-segment-prefetch"];
        if (prefetch) return route.continue();
        held = route;
      },
    );

    await page.locator('a[href="/app/calendar"]:visible').first().click();

    await expect(page).toHaveURL(/\/app\/calendar$/);
    await expect(page.locator(".route-loading")).toBeVisible();
    await expect(page.locator("h1.topbar-title")).toHaveText("Calendar");
    await expect(page.locator(".route-loading [role=status]")).toHaveText("Loading…");
    expect(held, "the page's own request is still waiting").not.toBeNull();

    await page.unroute((url) => url.pathname === "/app/calendar");
    await held!.continue();
    await expect(page.locator(".route-loading")).toHaveCount(0);

    await context.close();
  });
});
