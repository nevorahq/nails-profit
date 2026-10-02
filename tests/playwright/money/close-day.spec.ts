import { expect, test } from "../fixtures";
import {
  bookAppointment,
  daysFromToday,
  disposeStudio,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/**
 * Moves an appointment to three hours ago: over, not in progress — a ninety
 * minute visit an hour ago would still be being worked.
 */
async function alreadyOver(studio: Studio, bookingId: string) {
  const current = await studio.owner.get<{ version: number }>(`/api/v1/bookings/${bookingId}`);
  const startsAt = new Date(Date.now() - 3 * 60 * 60_000);
  startsAt.setUTCSeconds(0, 0);
  await studio.owner.post(`/api/v1/bookings/${bookingId}/reschedule`, {
    starts_at: startsAt.toISOString(),
    version: current.version,
  });
}

/**
 * «Закройте прошедшие записи»: an appointment that happened and was never
 * closed is named on the first screen and in the bell, and one tap turns it
 * into the visit its money belongs to.
 */
test.describe("closing the day", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("a past appointment is closed from the first screen at its «Итого»", async (
    { browser, baseURL, browserErrors },
    testInfo,
  ) => {
    void browserErrors;
    const booking = await bookAppointment(studio.owner, studio, { startsAt: daysFromToday(1) });
    await alreadyOver(studio, booking.id);

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto("/app");

    const panel = page.locator("#close-day");
    await expect(panel).toContainText("Close past appointments");
    await expect(panel).toContainText("1 appointment has passed");
    await expect(panel).toContainText("Manicure with coating");

    // The bell says the same, and leads here.
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.getByRole("menuitem", { name: "1 past appointment waits to be closed" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.screenshot({ path: testInfo.outputPath("close-day-panel.png"), fullPage: true });

    await panel.getByRole("button", { name: "Took place — MDL 600.00" }).click();
    await expect(panel).toHaveCount(0);

    await page.goto("/app/visits");
    await expect(page.locator(".visit-card-total")).toContainText("MDL 600.00");
    await context.close();
  });

  test("a master sees their own past appointment, not a colleague's", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const own = await bookAppointment(studio.owner, studio, { startsAt: daysFromToday(1) });
    const colleagues = await bookAppointment(studio.owner, studio, {
      startsAt: daysFromToday(2),
      specialistId: studio.colleagueId,
    });
    await alreadyOver(studio, own.id);
    await alreadyOver(studio, colleagues.id);

    const context = await signedInContext(browser, studio.master, baseURL!);
    const page = await context.newPage();
    await page.goto("/app");

    const panel = page.locator("#close-day");
    await expect(panel).toContainText("1 appointment has passed");
    await expect(panel.locator(".close-day-item")).toHaveCount(1);
    await context.close();
  });
});
