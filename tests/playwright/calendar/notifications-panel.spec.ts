import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import {
  cancelAsClient,
  daysFromToday,
  disposeStudio,
  requestAppointmentAsClient,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/*
 * The bell and its lines, each waited for until the server has answered.
 *
 * Opening the bell reloads the list, and a line is read locally at once and
 * written behind it. Either answer can arrive after the click that follows: a
 * reload sent before a write brings the line back unread, and one that lands
 * after the next click undoes it. A person is slower than both; a test is not.
 */
async function openBell(page: Page) {
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/notifications"),
    page.locator(".topbar-notifications").click(),
  ]);
}

async function readLine(page: Page, line: Locator) {
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/notifications/read"),
    line.click(),
  ]);
}

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
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto("/app/calendar");

    const items = page.locator(".notifications-panel .notifications-item");

    await openBell(page);
    // Both visits are off, so neither is waiting on an answer: everything in
    // the panel is the feed.
    await expect(items).toHaveCount(2);
    await expect(page.locator(".notifications-panel .notifications-item.unread")).toHaveCount(2);

    // The top line is the newer of the two, which is the one a record would put
    // first and a queue still does — until it has been dealt with.
    const opened = await items.first().getAttribute("href");
    expect(opened).toBeTruthy();
    await readLine(page, items.first());
    await expect(page).toHaveURL(new RegExp("/app/calendar\\?date="));

    await openBell(page);
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
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto("/app/calendar");

    const badge = page.locator(".topbar-notifications-badge");
    const items = page.locator(".notifications-panel .notifications-item");
    await expect(badge).toHaveCount(1);

    // One of the two, opened: still something left, so the dot stays.
    await openBell(page);
    await readLine(page, items.first());
    await expect(badge).toHaveCount(1);

    // And the other. Reopened rather than assumed, because the panel closes on
    // a click and the count is the server's answer, not the browser's guess.
    await openBell(page);
    await expect(items).toHaveCount(2);
    await readLine(page, page.locator(".notifications-panel .notifications-item.unread").first());
    await expect(badge).toHaveCount(0);

    await context.close();
  });
  /**
   * And an answer that was already on its way when the line was opened.
   *
   * Opening the bell asks for the list again; opening a line reads it at once
   * and writes behind. A list asked for before that write is a list in which
   * the line is still unread, and it used to be taken as it came — the dot
   * back on for the thirty seconds until the next poll. Staged here rather
   * than hoped for: the answer is fetched from the server before the click and
   * handed to the page only after the write has landed.
   */
  test("an answer sent before the line was opened does not light it again", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    // One unread line, so the dot is that line's alone.
    const { feed } = await studio.owner.get<{ feed: { booking_id: string }[] }>(
      "/api/v1/notifications?locale=en",
    );
    await studio.owner.post("/api/v1/notifications/read", { booking_id: feed[1].booking_id });

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    let holding = false;
    let fetched!: () => void;
    let release!: () => void;
    const answerFetched = new Promise<void>((resolve) => (fetched = resolve));
    const answerReleased = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === "/api/v1/notifications",
      async (route) => {
        if (!holding) return route.continue();
        holding = false;
        const response = await route.fetch();
        fetched();
        await answerReleased;
        await route.fulfill({ response });
      },
    );

    await page.goto("/app/calendar");
    const badge = page.locator(".topbar-notifications-badge");
    await expect(badge).toHaveCount(1);

    holding = true;
    await page.locator(".topbar-notifications").click();
    await answerFetched;
    await readLine(page, page.locator(".notifications-panel .notifications-item.unread").first());
    await expect(badge).toHaveCount(0);

    const stale = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/notifications");
    release();
    await stale;
    // The page parses and applies the answer after the response event; a
    // moment for that, since what is asserted is that nothing comes back.
    await page.waitForTimeout(500);
    await expect(badge).toHaveCount(0);

    await context.close();
  });
});
