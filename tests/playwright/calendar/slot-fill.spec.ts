import { expect, test } from "../fixtures";
import { closeTestConnections } from "../../helpers/database";
import { createVisit } from "../../helpers/factories";
import {
  bookAppointment,
  daysFromToday,
  disposeStudio,
  isoDate,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/**
 * «Освободилось время»: an appointment cancelled from the calendar, and under
 * it the clients who are due back, each with a message the desk can change
 * before it opens in a messenger.
 *
 * What has to hold is that the words the desk typed are the words that travel:
 * the link is built from the field, not from the text that was written for it.
 * At 375 px, because the desk that cancels is usually a phone in somebody's hand.
 */
test.use({ viewport: { width: 375, height: 812 } });

const DAY = 24 * 60 * 60 * 1000;

test.describe("the hour a cancellation gave back", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test.afterAll(async () => {
    await closeTestConnections();
  });

  /**
   * Three visits twenty days apart, the last thirty days ago: ten days past her
   * rhythm. Written straight into the table: the API will not backdate a visit
   * to before the master's commission rule began, which is today.
   */
  async function dueClient(name: string, phone: string) {
    const client = await studio.owner.post<{ id: string }>("/api/v1/clients", { name, phone });
    for (const days of [70, 50, 30]) {
      await createVisit(studio.organizationId, {
        specialistId: studio.specialistId,
        serviceId: studio.serviceId,
        clientId: client.id,
        completedAt: new Date(Date.now() - days * DAY),
      });
    }
    return client.id;
  }

  async function cancelFromTheCalendar(page: import("@playwright/test").Page, bookingId: string, day: Date) {
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    const entry = page.locator(`#booking-${bookingId}`);
    await entry.locator("summary").first().click();
    const form = entry.locator("details.calendar-subform").filter({ hasText: "Asked by" });
    await form.locator("summary").click();
    await form.getByRole("button", { name: "Cancel" }).click();
    return entry;
  }

  test("cancelling offers the hour to a client who is due back, with a message to edit", async ({
    browser,
    baseURL,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    await dueClient("Rita Return", "+37369111222");
    const day = daysFromToday(2);
    const booking = await bookAppointment(studio.owner, studio, { startsAt: day });

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const entry = await cancelFromTheCalendar(page, booking.id, day);
    await expect(entry).toContainText("Cancelled");

    // Opened by itself: the desk that has just taken the hour back is the one
    // that can still fill it.
    const offer = entry.getByRole("region", { name: "A time has opened up — who to offer it to" });
    await expect(offer).toBeVisible();
    await expect(offer).toContainText("Rita Return");
    await expect(offer).toContainText("nothing goes out on its own");

    await offer.getByRole("button", { name: "Write" }).click();
    const field = offer.getByLabel("Message text — you can edit it");
    // Written for her: her name, the studio's, and the hour.
    await expect(field).toHaveValue(/Rita Return/);
    await expect(field).toHaveValue(/A time has opened up/);

    // Edited, and the way to send follows the edit rather than the original.
    await field.fill("Rita, a window opened — want it? Reply here.");
    const sms = offer.locator('a[data-channel="sms"]');
    const href = (await sms.getAttribute("href"))!;
    expect(href).toMatch(/^sms:\+37369111222\?&body=/);
    expect(decodeURIComponent(href.split("body=")[1])).toBe("Rita, a window opened — want it? Reply here.");

    // Emptied: there is nothing to send, so no way to send it.
    await field.fill("");
    await expect(sms).toHaveCount(0);
    await expect(offer).toContainText("There is no text");

    await field.fill("Back again");
    await expect(sms).toHaveCount(1);

    await page.screenshot({ path: testInfo.outputPath("slot-fill-375.png"), fullPage: true });
    // Nothing on the card pushes the phone screen sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    expect(errors).toEqual([]);
    await context.close();
  });

  test("with nobody due back it says so instead of drawing an empty list", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const day = daysFromToday(2);
    const booking = await bookAppointment(studio.owner, studio, { startsAt: day });

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    const entry = await cancelFromTheCalendar(page, booking.id, day);
    const offer = entry.getByRole("region", { name: "A time has opened up — who to offer it to" });
    await expect(offer).toContainText("Nobody to offer it to right now");
    await expect(offer.getByRole("button", { name: "Write" })).toHaveCount(0);

    await context.close();
  });

  test("a cancelled hour is offered on demand when the page is opened later", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    await dueClient("Rita Return", "+37369111222");
    const day = daysFromToday(2);
    const booking = await bookAppointment(studio.owner, studio, { startsAt: day });
    await studio.owner.post(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: "client_request",
      cancelled_by: "client",
      version: booking.version,
    });

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    const entry = page.locator(`#booking-${booking.id}`);
    await entry.locator("summary").first().click();

    const offer = entry.getByRole("region", { name: "A time has opened up — who to offer it to" });
    // Not asked until somebody asks: a day of cancellations runs no lists.
    await expect(offer).not.toContainText("Rita Return");
    await offer.getByRole("button", { name: "Who to offer this time to" }).click();
    await expect(offer).toContainText("Rita Return");

    await context.close();
  });

  test("an appointment still held has no such offer", async ({ browser, baseURL, browserErrors }) => {
    void browserErrors;
    const day = daysFromToday(2);
    const booking = await bookAppointment(studio.owner, studio, { startsAt: day });

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    const entry = page.locator(`#booking-${booking.id}`);
    await entry.locator("summary").first().click();

    await expect(entry.getByRole("region", { name: "A time has opened up — who to offer it to" })).toHaveCount(0);

    await context.close();
  });
});
