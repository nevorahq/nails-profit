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
 * Calling the client from the appointment.
 *
 * «Клиент опаздывает» and «клиент не отвечает» are both answered by picking up
 * the phone, and the card is where the desk is standing when either happens.
 * The number was printed there to be read aloud and typed into a handset; this
 * is the same number as something to press.
 *
 * What has to hold is that the number shown and the number dialled are one
 * number. A `tel:` href is the one thing on this screen a reader cannot check
 * before acting on it — by the time the dialler opens, the call is the studio's
 * problem, and a card that displays one client and rings another is worse than
 * one that offers no link at all.
 */
test.describe("the client's number on an appointment", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("dials exactly the number it prints", async ({ browser, browserErrors }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?date=${isoDate(daysFromToday(1))}`);
    await page.locator(".calendar-entry summary").first().click();

    const call = page.locator(".calendar-call");
    await expect(call).toHaveCount(1);

    const shown = (await call.textContent())!.trim();
    const href = await call.getAttribute("href");

    // The assertion this test exists for.
    expect(href).toBe(`tel:${shown}`);

    /*
     * And the stored form is one a dialler accepts. The client typed «+373 69
     * 384050» into the public page; `normalizePhone` is what turns that into
     * `+37369384050`, and a `tel:` href carrying the spaces back would be a
     * number some handsets refuse.
     */
    expect(shown).toMatch(/^\+\d{8,15}$/);

    await context.close();
  });

  /**
   * Section 6.1: an Analyst reads client history «без телефонов и email». The
   * link is built from the column, and under `exclude_pii` the column arrives
   * null — so there is nothing to build it from and nothing to press.
   */
  test("offers a master the call and prints no number they may not see", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?date=${isoDate(daysFromToday(1))}`);
    await page.locator(".calendar-entry summary").first().click();

    // A Master keeps their own clients' contacts: theirs is the appointment.
    const call = page.locator(".calendar-call");
    await expect(call).toHaveCount(1);
    await expect(call).toHaveAttribute("href", /^tel:\+\d+$/);

    await context.close();
  });
});
