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
 * A day and a list are grouped by person; a week is grouped by date. So the
 * face belongs over a master's column and nowhere else — a circle over
 * «2026-09-08» would be a decoration pretending to be a portrait, and this is
 * the test that keeps one from appearing there.
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

  /**
   * The list is grouped by master too, and its window is a fortnight — so the
   * card has to say which day it is on. It used to print a bare «10:00–11:30»,
   * which was readable while the list was one run in time order and stops being
   * readable the moment a master's Tuesday and Friday sit next to each other.
   *
   * What it must not do is lay itself out against a column of hours: that is
   * the day's grid, and a fortnight does not fit on one axis of them.
   */
  test("gives the list a master's column, a face, and a date on each card", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?view=list&date=${isoDate(day)}`);

    const columnHead = page.locator(".calendar-column > h2");
    await expect(columnHead).toContainText(studio.specialistName);
    await expect(columnHead.locator(".avatar")).toHaveText(
      studio.specialistName.slice(0, 1).toUpperCase(),
    );

    // The date, on the entry itself.
    const entry = page.locator(".calendar-entry").first();
    await expect(entry.locator(".calendar-day")).toBeVisible();

    // And the master's name is not repeated inside their own column.
    await expect(entry.locator(".calendar-who .unit-hint")).toHaveCount(0);

    // No timetable: the hour ruler belongs to the day view.
    await expect(page.locator(".calendar-grid")).toHaveCount(0);

    await context.close();
  });
});
