import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * «Add to calendar» on the client's own page.
 *
 * Two ways in, because phones differ: a file an iPhone or Outlook opens with
 * «Add», and a link that opens Google Calendar with the visit filled in. The
 * button is there while there is a visit to go to, and gone once there is not.
 */
test.describe("the client's page puts the visit in their calendar", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("offers a file and a Google link while the visit stands", async ({ browser, baseURL, browserErrors }) => {
    void browserErrors;
    const booking = await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(2) });

    const client = await browser.newContext();
    const page = await client.newPage();
    await page.goto(`/booking/${booking.manage_token}`);

    const calendar = page.locator(".booking-calendar");
    await calendar.getByText("Add to calendar").click();
    const file = calendar.getByRole("link", { name: "iPhone, Outlook and others" });
    const google = calendar.getByRole("link", { name: "Google Calendar" });
    await expect(file).toBeVisible();
    await expect(google).toBeVisible();

    // The file is served, not generated in the page: Safari offers «Add» for this.
    const response = await page.request.get((await file.getAttribute("href"))!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
    const ics = (await response.text()).replace(/\r\n /g, "");
    // A request the studio has not answered is in the calendar as not settled.
    expect(ics).toContain("STATUS:TENTATIVE");
    expect(ics).toContain(studio.specialistName);
    expect(ics).toContain(`/booking/${booking.manage_token}`);

    // Google's link has the visit and not the key to it.
    const href = new URL((await google.getAttribute("href"))!);
    expect(href.hostname).toBe("calendar.google.com");
    expect(href.searchParams.get("text")).toContain("Manicure with coating");
    expect(href.toString()).not.toContain(booking.manage_token);
    await expect(google).toHaveAttribute("target", "_blank");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // Cancelled, there is nothing to go to: no button, and no file either.
    await studio.owner.post(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: "studio_request",
      cancelled_by: "staff",
    });
    await page.reload();
    await expect(page.locator(".role-badge")).toHaveText("Cancelled");
    await expect(calendar).toHaveCount(0);
    expect((await page.request.get(`/api/v1/public/bookings/${booking.manage_token}/calendar`)).status()).toBe(404);

    await client.close();
  });
});
