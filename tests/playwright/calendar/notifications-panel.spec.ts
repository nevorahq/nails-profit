import { expect, test } from "../fixtures";
import {
  cancelAsClient,
  daysFromToday,
  disposeStudio,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * The bell as a queue rather than as a record.
 *
 * «Что произошло» used to be one run of time, and opening the panel marked the
 * whole of it read at once. That answers «есть ли что-то новое» and nothing
 * else — so the line somebody had already dealt with sat above the two they had
 * not, purely because it had moved most recently, and the dot went out because
 * they had glanced at the list rather than because they had worked through it.
 *
 * Now opening an appointment is what reads its own line: that line drops below
 * everything still waiting, and the others keep their place. Nothing is hidden,
 * which is the whole reason this is a sort — an accidental click costs the
 * reader a line's position and never the line.
 */
test.describe("the bell's list of what happened", () => {
  let studio: Studio;

  /*
   * A studio per test rather than per file, which is not the habit of the specs
   * beside this one and has to be.
   *
   * Those read the calendar; these two write the thing they are about — what
   * this reader has already dealt with — and `fullyParallel` runs the tests of
   * one file at the same time. Sharing a studio meant the badge test marking a
   * line read while the sorting test was counting unread ones, which passes
   * alone and fails in a full run, i.e. in the worst possible way.
   */
  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);

    // Two clients calling off two visits: two lines, and two is the smallest
    // number that can be in the wrong order.
    for (const day of [1, 2]) {
      const booking = await requestAppointmentAsClient(baseURL!, studio, {
        date: daysFromToday(day),
      });
      await cancelAsClient(baseURL!, booking.manage_token);
    }
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("sinks the line whose appointment was opened, and leaves the rest", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");

    const bell = page.locator(".topbar-notifications");
    const items = page.locator(".notifications-panel .notifications-item");

    await bell.click();
    // Both visits are off, so neither is waiting on an answer: everything in
    // the panel is the feed.
    await expect(items).toHaveCount(2);
    await expect(page.locator(".notifications-panel .notifications-item.unread")).toHaveCount(2);

    // The top line is the newer of the two, which is the one a record would put
    // first and a queue still does — until it has been dealt with.
    const opened = await items.first().getAttribute("href");
    expect(opened).toBeTruthy();
    await items.first().click();
    await expect(page).toHaveURL(new RegExp("/app/calendar\\?date="));

    await bell.click();
    await expect(items).toHaveCount(2);
    // Nothing was hidden — it moved. The one still waiting is now on top, and
    // the one that was opened is underneath it and no longer marked.
    await expect(page.locator(".notifications-panel .notifications-item.unread")).toHaveCount(1);
    await expect(items.first()).toHaveClass(/unread/);
    await expect(items.nth(1)).not.toHaveClass(/unread/);
    await expect(items.nth(1)).toHaveAttribute("href", opened!);

    await context.close();
  });

  /**
   * And the dot, which used to go out because somebody had opened the panel.
   *
   * It is the same claim as the list's, made where a studio actually sees it:
   * the badge is the reason anybody opens the bell at all, and a badge that
   * clears itself on a glance says «you have looked» when the question is
   * «is there anything left».
   */
  test("keeps the badge lit until every line has been dealt with", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");

    const badge = page.locator(".topbar-notifications-badge");
    const items = page.locator(".notifications-panel .notifications-item");
    await expect(badge).toHaveCount(1);

    // One of the two, opened: still something left, so the dot stays.
    await page.locator(".topbar-notifications").click();
    await items.first().click();
    await expect(badge).toHaveCount(1);

    // And the other. Reopened rather than assumed, because the panel closes on
    // a click and the count is the server's answer, not the browser's guess.
    await page.locator(".topbar-notifications").click();
    await expect(items).toHaveCount(2);
    await page.locator(".notifications-panel .notifications-item.unread").first().click();
    await expect(badge).toHaveCount(0);

    await context.close();
  });
});
