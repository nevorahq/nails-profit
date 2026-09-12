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
 * It was first fixed at the symptom — widen the link to the statuses that stay
 * live, and show a master the filter so they can clear it. The filter panel has
 * since gone from the calendar, which took the second half of that fix away, so
 * the first half was replaced with the cause: the link stops naming a status
 * at all. A day nobody filtered cannot lose an appointment to a filter.
 *
 * Three things have to stay true for the bug not to come back, one per test:
 * the link may not carry a status, confirming has to leave the appointment on
 * the screen that confirmed it, and a filter the link *does* still carry — the
 * master it names — has to be one the reader can undo on screen.
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

  test("the notification link names a day and a master, and no status", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const booking = await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });

    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");
    await page.getByRole("button", { name: "Notifications" }).click();

    const href = await page.getByRole("menuitem").first().getAttribute("href");
    const query = new URL(href!, "http://127.0.0.1").searchParams;

    // The assertion this test exists for. A status here is a state the reader
    // arrives in and — since the filter panel went — cannot get out of, and
    // confirming the request is what moves the booking out of it.
    expect(query.get("status")).toBeNull();

    expect(query.get("date")).toBe(isoDate(daysFromToday(1)));
    expect(query.get("specialist")).toBe(studio.specialistId);
    expect(booking.status).toBe("pending_confirmation");

    await context.close();
  });

  test("an owner can clear the master the link narrowed the day to", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    // One request each, so a day narrowed to one master is visibly narrower
    // than the same day whole.
    await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });
    await requestAppointmentAsClient(baseURL!, studio, {
      date: daysFromToday(1),
      specialistId: studio.colleagueId,
      name: "Colleague Client",
    });

    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    // Arriving the way the bell sends an owner: one master's day.
    await page.goto(
      `/app/calendar?date=${isoDate(daysFromToday(1))}&specialist=${studio.specialistId}`,
    );
    await expect(page.locator(".calendar-entry")).toHaveCount(1);

    // The control is on the bar rather than behind a button, and it is showing
    // the state the link put the reader in rather than a neutral default —
    // which is what makes the filter visible at all.
    // Scoped to the bar: «Мастер» also labels a select in each of the compose
    // forms further down the page, and those are a different question.
    const picker = page.locator(".calendar-specialist");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue(studio.specialistId);

    await picker.selectOption("");

    // Choosing is applying: there is no «Show» to press afterwards.
    await expect(page.locator(".calendar-entry")).toHaveCount(2);
    await expect(page).toHaveURL(/date=/);
    expect(new URL(page.url()).searchParams.get("specialist")).toBeNull();

    await context.close();
  });
});
