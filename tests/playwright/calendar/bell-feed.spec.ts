import { expect, test } from "../fixtures";
import {
  cancelAsClient,
  daysFromToday,
  disposeStudio,
  isoDate,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * The bell, on the day a client calls a visit off.
 *
 * Reported by a studio on 13.09.2026: «сейчас была отменена запись клиентом, на
 * странице мастера оповещения нет». Nothing had broken. The bell listed
 * appointments waiting to be confirmed and nothing else, so a cancellation had
 * no place in it to appear — the studio's only warning was an email a minute
 * later, and the app itself carried on as though the hour were still sold.
 *
 * It now has two halves: what is waiting for an answer, and what has already
 * happened. This walks the second one end to end, because every part of it —
 * the dot, the line, the link, and the reading that puts the dot out — is worth
 * exactly nothing if it works anywhere but in a browser.
 */
test.describe("the bell after a client changes their mind", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("shows the cancellation, leads to the day, and stops being new once read", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const day = daysFromToday(1);
    const booking = await requestAppointmentAsClient(baseURL!, studio, { date: day, name: "Olga" });
    await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {});

    // The client, on their own link, while nobody in the studio is looking.
    const cancelled = await cancelAsClient(baseURL!, booking.manage_token);
    expect(cancelled.status).toBe("cancelled");

    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");

    // The dot: something happened that this person has not seen.
    const bell = page.getByRole("button", { name: "Notifications" });
    await expect(bell.locator(".topbar-notifications-badge")).toBeVisible();

    await bell.click();
    const line = page.getByRole("menuitem").filter({ hasText: "Olga" });
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("cancelled by the client");
    // Under the two groups' headings, because both halves are on screen only
    // when both have something in them — here the feed alone does.
    await expect(page.locator(".notifications-group")).toHaveText("What happened");

    // The link goes where the hour is: that master's day.
    const href = await line.getAttribute("href");
    const query = new URL(href!, "http://127.0.0.1").searchParams;
    expect(query.get("date")).toBe(isoDate(day));
    expect(query.get("specialist")).toBe(studio.specialistId);

    // Opening the list is what reads it, and reading it survives a reload:
    // the mark is the studio's, not this tab's.
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(bell.locator(".topbar-notifications-badge")).toHaveCount(0);

    await bell.click();
    await expect(page.getByRole("menuitem").filter({ hasText: "Olga" })).toHaveCount(1);

    await context.close();
  });
});
