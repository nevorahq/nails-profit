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

/*
 * The same panel where it is used most — a phone between two clients — at the
 * narrowest width the product supports. Nothing may scroll sideways, and each
 * of the three answers has to be reachable.
 */
test.describe("closing the day at 375 px", () => {
  let studio: Studio;
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("«Неявка» takes the appointment off the list without a visit", async (
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
    const item = panel.locator(".close-day-item");
    await expect(item).toHaveCount(1);
    for (const action of [
      item.getByRole("button", { name: "Took place — MDL 600.00" }),
      item.getByRole("button", { name: "No-show" }),
      item.getByRole("link", { name: "Different amount" }),
    ]) {
      await expect(action).toBeVisible();
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath("close-day-375.png"), fullPage: true });

    await item.getByRole("button", { name: "No-show" }).click();
    await expect(panel).toHaveCount(0);
    const after = await studio.owner.get<{ status: string }>(`/api/v1/bookings/${booking.id}`);
    expect(after.status).toBe("no_show");

    await page.goto("/app/visits");
    await expect(page.locator(".visit-card-total")).toHaveCount(0);
    await context.close();
  });

  test("«Другая сумма» opens the appointment ready for the amount", async (
    { browser, baseURL, browserErrors },
    testInfo,
  ) => {
    void browserErrors;
    const booking = await bookAppointment(studio.owner, studio, { startsAt: daysFromToday(1) });
    await alreadyOver(studio, booking.id);

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto("/app");
    await page.locator("#close-day").getByRole("link", { name: "Different amount" }).click();
    await page.waitForURL(`**/app/calendar?**booking=${booking.id}`);

    // Straight to the field: the card and its form are open, the cursor in it.
    const entry = page.locator(`#booking-${booking.id}`);
    const paid = entry.getByLabel("Client paid, MDL");
    await expect(paid).toBeVisible();
    await expect(paid).toBeFocused();
    await expect(paid).toHaveValue("600");
    await page.screenshot({ path: testInfo.outputPath("close-day-other-amount-375.png"), fullPage: true });

    await paid.fill("550");
    await entry
      .locator("details.calendar-subform form")
      .getByRole("button", { name: "Close into a visit" })
      .click();
    await expect(entry).toContainText("Completed");

    await page.goto("/app/visits");
    await expect(page.locator(".visit-card-total")).toContainText("MDL 550.00");
    await context.close();
  });
});

