import postgres from "postgres";

import { expect, test } from "../fixtures";
import { daysFromToday, disposeStudio, isoDate, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * The visit list opens on this month, and its totals are the month's.
 *
 * It used to open on every visit since the studio began: a page that grows with
 * the studio and a total for all of history nobody had asked for. Canonical
 * studio: a 600 MDL service, so a total says at a glance how many visits it
 * adds up.
 */
test.describe("the visit list's period", () => {
  let studio: Studio;
  let olderVisitId: string;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    const close = async () =>
      (
        await studio.owner.post<{ id: string }>("/api/v1/visits", {
          specialist_id: studio.specialistId,
          service_id: studio.serviceId,
        })
      ).id;
    olderVisitId = await close();
    await close();

    // The product closes a visit at the moment it is closed, and a commission
    // rule applies from the day it was written, so a visit cannot be closed into
    // last month through the API. The date is moved the one way the fixture has:
    // the owner connection the suite already holds. Forty-five days back is never
    // this month, and never later than it.
    const owner = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false });
    try {
      await owner`update visit set completed_at = ${daysFromToday(-45)} where id = ${olderVisitId}`;
    } finally {
      await owner.end();
    }
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("shows this month's visit and total, not the older one", async ({ browser, baseURL, browserErrors }) => {
    void browserErrors;
    const page = await (await signedInContext(browser, studio.owner, baseURL!)).newPage();
    await page.goto("/app/visits");

    await expect(page.locator(".visit-card")).toHaveCount(1);
    await expect(page.locator(".visit-card-total")).toContainText("MDL 600.00");
    await expect(page.locator(".visit-card-total")).not.toContainText("MDL 1,200.00");
    await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute("aria-current", "true");
  });

  test("shows both, and adds them up, when the period reaches the older one", async ({ browser, baseURL, browserErrors }) => {
    void browserErrors;
    const page = await (await signedInContext(browser, studio.owner, baseURL!)).newPage();
    await page.goto(`/app/visits?from=${isoDate(daysFromToday(-60))}&to=${isoDate(daysFromToday(1))}`);

    await expect(page.locator(".visit-card")).toHaveCount(2);
    await expect(page.locator(".visit-card-total")).toContainText("MDL 1,200.00");
  });

  test("opens one visit from any month when it is linked to by id", async ({ browser, baseURL, browserErrors }) => {
    void browserErrors;
    const page = await (await signedInContext(browser, studio.owner, baseURL!)).newPage();
    await page.goto(`/app/visits?visit=${olderVisitId}`);

    await expect(page.locator(".visit-card")).toHaveCount(1);
    await expect(page.locator(`#visit-${olderVisitId}`)).toBeVisible();
  });

  test("says the period is empty, rather than inviting the first visit, when only other months have any", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const page = await (await signedInContext(browser, studio.owner, baseURL!)).newPage();
    await page.goto("/app/visits?from=2020-01-01&to=2020-01-31");

    await expect(page.locator(".visit-card")).toHaveCount(0);
    await expect(page.getByText("No visits in this period.")).toBeVisible();
    await expect(page.locator(".section-empty")).toHaveCount(0);
  });
});
