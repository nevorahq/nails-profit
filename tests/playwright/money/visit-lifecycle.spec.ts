import { expect, test } from "../fixtures";
import type { Locator } from "@playwright/test";
import {
  daysFromToday,
  disposeStudio,
  moveIntoThePast,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * The whole product in one pass: a stranger asks for a time, the studio answers,
 * the work is closed, and the month says what it earned.
 *
 * The figures are the canonical ones the vitest suites already protect — 600
 * MDL of work at a 40% commission keeps 360 — but they are checked here through
 * the screens, which is where they are read in practice. A unit test proves the
 * arithmetic; this proves the arithmetic reaches the page, in the studio's own
 * currency and locale, after passing through a preview, a mutation and two
 * server-rendered reports.
 */
/**
 * Closes and reopens a card, which is how its completion preview is fetched.
 *
 * `loadPreview` hangs off the `<details>` toggle, so a card that was already
 * open when the appointment became confirmed never asks for one — the figures
 * appear the next time somebody opens it. A studio that confirms and then reads
 * the card in place is in exactly that state.
 */
async function reopenCard(entry: Locator) {
  await entry.locator("summary").first().click();
  await entry.locator("summary").first().click();
  await expect(entry.locator("details").first()).toHaveJSProperty("open", true);
}

/**
 * Opens an appointment card, and only if it is shut.
 *
 * The card is a `<details>`, and a mutation re-renders the day from the server
 * — sometimes with the card open, sometimes not. Clicking the summary blind
 * therefore closes it half the time, and the preview the studio is meant to
 * read never loads, because it is fetched on the toggle.
 */
async function openCard(entry: Locator) {
  const card = entry.locator("details").first();
  if (!(await card.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await entry.locator("summary").first().click();
  }
  await expect(card).toHaveJSProperty("open", true);
}

test.describe("from a client's request to the month's profit", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("an appointment is confirmed, closed into a visit and counted in the month", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const booking = await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });
    expect(booking.status).toBe("pending_confirmation");

    // The client asked for tomorrow, as clients do. The studio then moves it to
    // an hour ago, because the rest of this test is about closing the work, and
    // a visit cannot be closed before its appointment has started.
    await moveIntoThePast(studio, booking.id);

    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto("/app/calendar");
    await page.getByRole("button", { name: "Notifications" }).click();
    await page.getByRole("menuitem").first().click();

    const entry = page.locator(".calendar-entry");
    await expect(entry).toHaveCount(1);
    await openCard(entry);
    await entry.getByRole("button", { name: "Confirm" }).click();
    await expect(entry).toContainText("Confirmed");

    // Reopening a confirmed card asks the server what closing it would produce.
    // The two figures are the ones the studio decides on: what the master earns
    // and what the studio keeps.
    await reopenCard(entry);
    await expect(entry).toContainText("MDL 240.00");
    await expect(entry).toContainText("MDL 360.00");

    await entry.getByRole("button", { name: "Close into a visit" }).click();

    // The appointment stays on the day it was closed on, now marked as
    // finished. It used to leave the screen here — the bell filtered the day to
    // the statuses still live, and closed work is not one of them — which was
    // correct and still read as a disappearance. The link no longer carries a
    // status, so there is nothing left to drop it.
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Completed");

    await page.goto("/app/visits");
    await expect(page.locator(".visit-card").filter({ hasText: "Manicure with coating" })).toHaveCount(1);

    // The card itself no longer prints figures — the four metrics were taken
    // out of this list — so the money is read where the page still states it,
    // under the list: what the work brought in, and what the master earned of
    // it. The same 600 and 240 as before, from the same visit.
    const total = page.locator(".visit-card-total");
    await expect(total).toContainText("MDL 600.00");
    await expect(total).toContainText("MDL 240.00");

    await page.goto("/app/reports/month");
    await expect(page.locator("main")).toContainText("MDL 600.00");

    await context.close();
  });

  test("a no-show is recorded without earning anything", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });

    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");
    await page.getByRole("button", { name: "Notifications" }).click();
    await page.getByRole("menuitem").first().click();

    const entry = page.locator(".calendar-entry");
    await openCard(entry);
    await entry.getByRole("button", { name: "Confirm" }).click();
    await expect(entry).toContainText("Confirmed");

    await openCard(entry);
    await entry.getByRole("button", { name: "No-show" }).click();
    await expect(entry).toContainText("No-show");

    // Nothing was worked, so nothing was earned: the ledger stays empty.
    await page.goto("/app/visits");
    await expect(page.locator("main")).toContainText("No visits yet.");

    await context.close();
  });
});
