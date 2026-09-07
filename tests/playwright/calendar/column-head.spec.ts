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
 * Who a column belongs to, said the way /app/visits says it.
 *
 * The day view is the only one grouped by person — a week and a list are
 * grouped by date — so the face belongs to the day's column heads and nowhere
 * else. A circle over «2026-09-08» would be a decoration pretending to be a
 * portrait, and this is the test that keeps one from appearing there.
 */
test.describe("the head of a calendar group", () => {
  let studio: Studio;
  const day = daysFromToday(1);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await requestAppointmentAsClient(baseURL!, studio, { date: day });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("names the master on a day and only the date on a week", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?view=day&date=${isoDate(day)}`);
    const columnHead = page.locator(".calendar-column > h2");
    await expect(columnHead).toHaveCount(1);
    await expect(columnHead).toContainText(studio.specialistName);

    // No photo on this account, so the circle carries the initial — the same
    // fallback the visits list draws.
    await expect(columnHead.locator(".avatar")).toHaveText(
      studio.specialistName.slice(0, 1).toUpperCase(),
    );

    await page.goto(`/app/calendar?view=week&date=${isoDate(day)}`);
    const dayHead = page.locator(".calendar-group h2").filter({ hasText: isoDate(day) });
    await expect(dayHead).toHaveCount(1);
    await expect(dayHead.locator(".avatar")).toHaveCount(0);

    await context.close();
  });
});
