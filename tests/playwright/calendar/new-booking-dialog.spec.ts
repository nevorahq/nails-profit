import { expect, test } from "../fixtures";
import { openBookingForm } from "../helpers/booking-form";
import {
  daysFromToday,
  disposeStudio,
  isoDate,
  requestAppointmentAsClient,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/**
 * «Записать клиента» is a window opened by the round «+», not a block on the
 * page, and the time in it is chosen from the day's free times.
 *
 * The fixture rota is 08:00–20:00 in UTC on an hourly grid, the service runs
 * ninety minutes, and an appointment already stands at 09:00 on the day under
 * test: it takes 09:00–10:30 and the ten-minute turnaround after it, so the
 * starts at 08:00, 09:00 and 10:00 are not free and 11:00 is.
 */
test.describe("the appointment window", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    await requestAppointmentAsClient(baseURL!, studio, { date: day, afterTime: "09:00", name: "Booked First" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  async function openCalendar(browser: Parameters<typeof signedInContext>[0], baseURL: string) {
    const context = await signedInContext(browser, studio.owner, baseURL);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    return { context, page };
  }

  test("is not on the page until the round button opens it", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);

    // Neither the toolbar's labelled button nor a form standing open.
    await expect(page.getByRole("link", { name: "New appointment" })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("New client's name")).toHaveCount(0);

    const dialog = await openBookingForm(page);
    // On the day the calendar was showing, not today.
    await expect(dialog.getByLabel("Date")).toHaveValue(isoDate(day));
    // Opening it is not a navigation: the day and the master behind the window stay.
    expect(page.url()).toContain(`date=${isoDate(day)}`);
    expect(page.url()).toContain(`specialist=${studio.specialistId}`);
    await context.close();
  });

  test("is as tall as its form, and only the page scrolls", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    const block = page.locator(".calendar-compose-scroll");
    const book = dialog.getByRole("button", { name: "Book", exact: true });

    // Once the free times have arrived: they change the form's height, so every
    // measurement below is of the form as it will stay.
    await expect(dialog.getByRole("status")).toHaveCount(0);

    // Nothing in the window scrolls: the card and the block round it show their
    // whole form, and neither is a scroll box.
    for (const element of [dialog, block]) {
      const inner = await element.evaluate((node) => ({
        overflow: getComputedStyle(node).overflowY,
        scrolls: node.scrollHeight > node.clientHeight + 1,
      }));
      expect(inner.overflow).toBe("visible");
      expect(inner.scrolls).toBe(false);
    }
    // The page ends where the form does: the calendar is out of the flow while it
    // is open, so nothing but the bottom bar's room follows the card.
    await expect(page.locator(".calendar-toolbar")).toBeHidden();
    const below = await page.evaluate(() => {
      const card = document.querySelector(".calendar-compose-dialog")!.getBoundingClientRect();
      return document.documentElement.scrollHeight - (card.bottom + window.scrollY);
    });
    expect(below).toBeLessThanOrEqual(130);

    // The block is exactly as tall as the card and its room — not a screen.
    const card = (await dialog.boundingBox())!;
    const room = (await block.boundingBox())!;
    expect(room.height).toBeGreaterThanOrEqual(card.height);
    expect(room.height).toBeLessThanOrEqual(card.height + 40);

    // The page is not held: it is the page that moves.
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");

    // At the top the form starts under the top bar, not behind it.
    const viewport = page.viewportSize()!;
    const topBar = (await page.locator(".app-topbar").boundingBox())!;
    expect(card.y).toBeGreaterThanOrEqual(topBar.y + topBar.height);

    // The end of the form is reachable by scrolling the page, and nothing draws
    // over it there: the last button is whole on screen, and the thing at its
    // centre is the button, not a bar. Instant: the page's own
    // `scroll-behavior: smooth` would still be moving when the position is read.
    await book.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" }));
    await expect(book).toBeInViewport({ ratio: 1 });
    const covered = await book.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top !== node && !node.contains(top);
    });
    expect(covered).toBe(false);

    // And lower still, the bottom bar is above the dimmed page, not the form: the
    // form's own end is never closer to it than the form's last button.
    const last = (await book.boundingBox())!;
    const bottomBar = await page.locator(".bottom-nav").boundingBox();
    const floor = bottomBar && bottomBar.height > 0 ? bottomBar.y : viewport.height;
    expect(last.y + last.height).toBeLessThanOrEqual(floor);

    // Back at the top, the page behind is dimmed and cannot be pressed.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(page.locator(".calendar-compose-dim")).toBeAttached();

    // The page scrolls the same once the window is closed.
    await page.keyboard.press("Escape");
    await expect(page.locator(".calendar-compose-dim")).toHaveCount(0);
    await context.close();
  });

  test("offers the free times of the chosen day, and not the taken ones", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await dialog.getByLabel("Specialist").selectOption({ label: studio.specialistName });

    const chip = (time: string) => dialog.getByRole("button", { name: time, exact: true });
    await expect(chip("11:00")).toBeVisible();
    for (const taken of ["08:00", "09:00", "10:00"]) await expect(chip(taken)).toHaveCount(0);

    // Another master has nobody booked: their 09:00 is free.
    await dialog.getByLabel("Specialist").selectOption({ label: studio.colleagueName });
    await expect(chip("09:00")).toBeVisible();

    await context.close();
  });

  test("asks again when the date changes", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await expect(dialog.getByRole("button", { name: "11:00", exact: true })).toBeVisible();

    const other = isoDate(daysFromToday(3));
    const asked = page.waitForRequest(
      (request) => request.url().includes("/api/v1/availability/slots") && request.url().includes(`date=${other}`),
    );
    await dialog.getByLabel("Date").fill(other);
    await asked;

    // Nothing stands on that day: the hour the first one took is free again.
    await expect(dialog.getByRole("button", { name: "09:00", exact: true })).toBeVisible();
    await context.close();
  });

  test("books the tapped time, closes, and puts the appointment in the day", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await dialog.getByLabel("Specialist").selectOption({ label: studio.specialistName });

    await dialog.getByRole("button", { name: "12:00", exact: true }).click();
    await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue("12:00");
    await expect(dialog.getByRole("button", { name: "12:00", exact: true })).toHaveAttribute("aria-pressed", "true");

    await dialog.getByLabel("New client's name").fill("Tapped Slot");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    const entry = page.locator(".calendar-entry").filter({ hasText: "Tapped Slot" });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("12:00");
    await context.close();
  });

  test("still takes a time typed by hand", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await dialog.getByLabel("Specialist").selectOption({ label: studio.specialistName });

    await dialog.getByLabel("Time", { exact: true }).fill("14:20");
    await dialog.getByLabel("New client's name").fill("Typed Time");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".calendar-entry").filter({ hasText: "Typed Time" })).toContainText("14:20");
    await context.close();
  });

  test("shows a refusal inside the window and keeps what was typed", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await dialog.getByLabel("Specialist").selectOption({ label: studio.specialistName });

    // 09:00 is the hour the fixture's appointment holds.
    await dialog.getByLabel("Time", { exact: true }).fill("09:00");
    await dialog.getByLabel("New client's name").fill("Double Booked");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("New client's name")).toHaveValue("Double Booked");
    await context.close();
  });

  test("closes on Escape and on «Cancel», but not on a tap outside it", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);

    let dialog = await openBookingForm(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    dialog = await openBookingForm(page);
    // A tap on the dimmed page beside the form: nothing happens.
    await page.mouse.click(3, 300);
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await context.close();
  });

  test("has a cross in its top right corner that closes it", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);

    const cross = dialog.getByRole("button", { name: "Close the window" });
    await expect(cross).toBeVisible();
    // An icon, not a labelled button: the name is for the screen reader.
    await expect(cross).toHaveText("");

    // In the card's top right corner, and big enough to press.
    const card = (await dialog.boundingBox())!;
    const box = (await cross.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(43);
    expect(box.height).toBeGreaterThanOrEqual(43);
    expect(card.x + card.width - (box.x + box.width)).toBeLessThanOrEqual(16);
    expect(box.y - card.y).toBeLessThanOrEqual(16);

    await cross.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // And the page is whole again behind it.
    await expect(page.locator(".calendar-toolbar")).toBeVisible();
    await context.close();
  });

  test("opens from the shell's link on arrival, and does not reopen on reload", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}#new-booking`);

    await expect(page.getByRole("dialog", { name: "New appointment" })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");

    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await context.close();
  });
});
