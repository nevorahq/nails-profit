import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * The client's own page, while the studio works on the other side of it.
 *
 * Reported from a studio on 12.09.2026: a master confirmed a request and called
 * it off half a minute later, and the client's open page went on saying
 * «Подтверждена». It was not a stale render — the page had stopped watching on
 * purpose, because it watched `pending_confirmation` and nothing else. Every
 * state after the studio's answer was invisible until the client reloaded, and
 * the only thing that did reach them was the email, four minutes later, which
 * is the channel this page exists because nobody can rely on.
 *
 * So the page now watches an appointment for as long as it is still ahead of
 * the client, and asks again the moment they come back to the tab. The second
 * half is what this test drives: a browser tab is always "visible", and waiting
 * out the timer would put two minutes of nothing into a test run.
 */
test.describe("the client's page while the studio changes their appointment", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("follows the answer and the cancellation that came after it", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const booking = await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });
    expect(booking.status).toBe("pending_confirmation");

    // The client, on the link their booking gave them. No account, no session:
    // this is a stranger's browser.
    const client = await browser.newContext();
    const page = await client.newPage();
    await page.goto(`/booking/${booking.manage_token}`);
    await expect(page.locator(".role-badge")).toHaveText("Awaiting confirmation");
    await expect(page.locator(".booking-watching")).toContainText("keep it open");

    /** Coming back to the tab, which is when a client asks their screen again. */
    const returnToTab = () =>
      page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

    await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {});
    await returnToTab();
    await expect(page.locator(".role-badge")).toHaveText("Confirmed");
    // The promise the page makes once there is nothing left to answer: it is
    // still watching, and it says what it is watching for.
    await expect(page.locator(".booking-watching")).toContainText("changes or cancels");

    // Half a minute later in the studio, and the whole point of this test: the
    // page used to stop here, and the client was left reading «Confirmed».
    await studio.owner.post(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: "studio_request",
      cancelled_by: "staff",
    });
    await returnToTab();
    await expect(page.locator(".role-badge")).toHaveText("Cancelled");
    await expect(page.locator(".booking-next-step")).toContainText(
      "The studio cancelled this appointment",
    );
    // Nothing is watched once nothing can change, and the page says so by
    // dropping the line rather than by promising to watch a closed booking.
    await expect(page.locator(".booking-watching")).toHaveCount(0);

    await client.close();
  });
});
