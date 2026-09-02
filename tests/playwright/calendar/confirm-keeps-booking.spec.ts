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
 * The regression this suite was written for, from commit 9ffa713.
 *
 * A master answered a client's request from the bell and watched the
 * appointment disappear. Nothing was deleted: the notification link carried
 * `status=pending_confirmation`, confirming is what takes a booking out of that
 * status, and the calendar refreshes on the same URL — so the answer erased the
 * question. The filter was invisible to a master, whose scope hid the whole
 * filter panel, and sticky, because every day-stepper link is built from the
 * filters currently in the URL.
 *
 * Three things have to stay true for it not to come back, one per test: the
 * link may not name only the state being left behind, a master has to be able
 * to see and undo the filter they arrived carrying, and confirming has to leave
 * the appointment on the screen that confirmed it.
 */
test.describe("confirming keeps the appointment visible", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("a master confirms a client's request and it stays on the day", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const booking = await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });
    expect(booking.status).toBe("pending_confirmation");

    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");

    // Through the bell, because that is the way in that broke. Going straight
    // to the URL would be testing a calendar nobody arrives at.
    await page.getByRole("button", { name: "Notifications" }).click();
    const request = page.getByRole("menuitem").first();
    await expect(request).toContainText("Manicure with coating");
    await request.click();

    const entry = page.locator(".calendar-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Awaiting confirmation");

    // The card's own disclosure, not the nested ones it contains (move, cancel,
    // send the client a manage link).
    await entry.locator("summary").first().click();
    await entry.getByRole("button", { name: "Confirm" }).click();

    // The assertion the bug failed: still there, now confirmed.
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Confirmed");
    await expect(page.getByText("Nothing booked.")).toHaveCount(0);

    await context.close();
  });

  test("the notification link asks for appointments that are still on", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });

    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");
    await page.getByRole("button", { name: "Notifications" }).click();

    const href = await page.getByRole("menuitem").first().getAttribute("href");
    const statuses = new URL(href!, "http://127.0.0.1").searchParams.get("status")?.split(",") ?? [];

    expect(statuses).toContain("pending_confirmation");
    expect(statuses).toContain("confirmed");

    await context.close();
  });

  test("a master can see and clear the status filter they arrived with", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });

    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();

    // Arriving with the narrowest filter a link can carry — the state the old
    // notification link left a master in, with no control to get out of it.
    await page.goto(`/app/calendar?view=day&date=${isoDate(daysFromToday(1))}&status=cancelled`);
    await expect(page.locator(".calendar-entry")).toHaveCount(0);

    const filters = page.locator("details.calendar-filters");
    await expect(filters).toBeVisible();
    await filters.locator("summary").click();

    // The specialist select stays withheld: a master's calendar is their own.
    await expect(filters.getByLabel("Specialist")).toHaveCount(0);

    await filters.getByLabel("Status").selectOption("");
    await filters.getByRole("button", { name: "Show" }).click();

    await expect(page.locator(".calendar-entry")).toHaveCount(1);
    await expect(page.locator(".calendar-entry")).toContainText("Awaiting confirmation");

    await context.close();
  });
});
