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
 * The month, and the day it chooses.
 *
 * The calendar is two blocks: a grid of dates, and the appointments of one of
 * them. The grid is navigation and nothing else — every cell is a link to its
 * own date — so the three things that have to stay true are that a date with
 * something in it says so, that pressing one changes the list underneath, and
 * that the date pressed is the one the list is about.
 *
 * A date is drawn as a mark per thing standing in it rather than as a number
 * alone, because the question a studio opens this page with is «когда есть
 * место»: an empty cell has to be readable as empty at a glance, across a
 * month, without counting anything.
 */
const todayIso = () => isoDate(new Date());

test.describe("the month grid", () => {
  let studio: Studio;
  const day = daysFromToday(1);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await requestAppointmentAsClient(baseURL!, studio, { date: day });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("marks the days that have something and lists the one that is chosen", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto("/app/calendar");

    // Today, with nothing booked: a cell, and no marks in it.
    const todayCell = page.locator(".calendar-cell.is-today");
    await expect(todayCell).toHaveCount(1);
    await expect(todayCell.locator(".calendar-mark")).toHaveCount(0);

    // Tomorrow, which has the client's request: one mark, coloured for the
    // status it is waiting in.
    const booked = page.locator(`.calendar-cell[href*="date=${isoDate(day)}"]`);
    await expect(booked.locator(".calendar-mark.status-pending_confirmation")).toHaveCount(1);

    // The grid opens on today, and today is what the list below is about.
    await expect(page.locator(".calendar-cell.is-selected")).toHaveText(/.*/);
    await expect(page.locator(".calendar-daylist")).toContainText("Nothing booked.");

    // Pressing a date moves the list to it — and moves the selection with it,
    // which is the half that tells the reader which day they are looking at.
    await booked.click();
    await expect(page.locator(".calendar-daylist .calendar-entry")).toHaveCount(1);
    await expect(page.locator(".calendar-cell.is-selected")).toHaveAttribute(
      "href",
      new RegExp(`date=${isoDate(day)}`),
    );

    // Seven headings over seven columns, whatever the locale spells them.
    await expect(page.locator(".calendar-weekdays span")).toHaveCount(7);

    await context.close();
  });

  /**
   * The grid is whole ISO weeks, so it carries the tail of the month before and
   * the head of the month after. Those dates are real and pressing one works —
   * the last days of the outgoing month are exactly what somebody looking at
   * the 1st wants next — but they must not be mistaken for this month's.
   */
  test("draws whole weeks and marks which dates belong to the month", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    // A month that both begins and ends mid-week, so the grid has to borrow at
    // each end: 1 September 2026 is a Tuesday and 30 September a Wednesday.
    await page.goto("/app/calendar?date=2026-09-15");

    const cells = page.locator(".calendar-cell");
    await expect(cells).toHaveCount(35);
    // Monday 31 August before it, Sunday 4 October after it, and the thirty
    // days of September itself.
    await expect(page.locator(".calendar-cell.is-outside")).toHaveCount(5);
    await expect(page.locator('.calendar-cell[href*="date=2026-08-31"]')).toHaveClass(/is-outside/);
    await expect(page.locator('.calendar-cell[href*="date=2026-09-01"]')).not.toHaveClass(
      /is-outside/,
    );

    await context.close();
  });

  /**
   * Where the reader is, and how it changes: the pair of selects, which is now
   * the only way of changing it. «Сегодня» and a pair of arrows stood here too
   * and were taken out — a second way to do what the grid and the month select
   * already do.
   *
   * The date both selects must not mishandle is a 31st. Changing the month of
   * 31 January to February gives a 31 February that the calendar normalizes
   * into March — two months of movement from one change of one field — so both
   * clamp to the end of the month being entered.
   */
  test("jumps whole months and years, clamping a date the target does not have", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    // The month and the year are two controls, so they are read as values
    // rather than as the text of the bar: the bar's text is every option in
    // both lists.
    const month = page.locator(".calendar-period select").first();
    const year = page.locator(".calendar-period select").last();

    await page.goto("/app/calendar?date=2026-01-31");
    await expect(month).toHaveValue("1");
    await expect(year).toHaveValue("2026");

    // Choosing is applying: there is nothing to press after.
    await month.selectOption("2");
    await expect(page).toHaveURL(/date=2026-02-28/);
    await expect(month).toHaveValue("2");

    // A leap day is the year's own version of the same trap: 2028 has a 29th of
    // February and 2027 does not. It is also a year outside the list's own
    // range, which the anchor joins so the control shows the year it is on.
    await page.goto("/app/calendar?date=2028-02-29");
    await expect(year).toHaveValue("2028");
    await year.selectOption("2027");
    await expect(page).toHaveURL(/date=2027-02-28/);

    // The arrows are gone — they stepped one month, which is what the month
    // select does. «Сегодня» stayed, and it is the reason they could: it is the
    // only way home from a month today is not in, where the grid has no ring to
    // press and the selects would take two trips.
    await expect(page.locator(".calendar-stepper")).toHaveCount(0);

    await page.getByRole("link", { name: "Today" }).click();
    await expect(page).toHaveURL(new RegExp(`date=${todayIso()}`));
    await expect(page.locator(".calendar-cell.is-selected")).toHaveClass(/is-today/);

    await context.close();
  });
});
