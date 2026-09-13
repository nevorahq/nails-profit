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
 * It is now four ways rather than one — a call, and the three messengers a
 * client who does not pick up may answer instead — and the number itself is
 * what opens them.
 *
 * What has to hold is that the number shown and the number reached are one
 * number. An address behind a link is the one thing on this screen a reader
 * cannot check before acting on it — by the time the dialler or the messenger
 * opens, the call is the studio's problem, and a card that displays one client
 * and rings another is worse than one that offers no link at all.
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

    const number = page.locator(".calendar-call");
    await expect(number).toHaveCount(1);
    const shown = (await number.textContent())!.trim();

    // The ways appear only when somebody asks for them: the card is dense
    // enough without three brand names nobody pressed.
    await expect(page.locator(".client-contact-ways")).toHaveCount(0);
    await number.click();

    const call = page.locator('.client-contact-way[data-channel="call"]');
    // The call is first and still one tap from the number, which is what this
    // line was before it was a menu.
    await expect(page.locator(".client-contact-way").first()).toHaveAttribute(
      "data-channel",
      "call",
    );

    // The assertion this test exists for.
    expect(await call.getAttribute("href")).toBe(`tel:${shown}`);

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
    const number = page.locator(".calendar-call");
    await expect(number).toHaveCount(1);
    await number.click();
    await expect(page.locator('.client-contact-way[data-channel="call"]')).toHaveAttribute(
      "href",
      /^tel:\+\d+$/,
    );

    await context.close();
  });

  /**
   * The three that are not a call, each in the shape its own service accepts —
   * bare digits for WhatsApp, bare digits for Telegram, an encoded plus for
   * Viber. Built from one column, so the way to get them wrong is to get them
   * all wrong at once, which is precisely what this asserts against.
   */
  test("offers the messengers the same number, each in its own form", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?date=${isoDate(daysFromToday(1))}`);
    await page.locator(".calendar-entry summary").first().click();
    const number = page.locator(".calendar-call");
    const shown = (await number.textContent())!.trim();
    const digits = shown.slice(1);
    await number.click();

    const ways = page.locator(".client-contact-way");
    await expect(ways).toHaveCount(4);
    await expect(ways.nth(1)).toHaveAttribute("href", `https://wa.me/${digits}`);
    await expect(ways.nth(2)).toHaveAttribute("href", `tg://resolve?phone=${digits}`);
    await expect(ways.nth(3)).toHaveAttribute("href", `viber://chat?number=%2B${digits}`);

    // And it closes the way a menu closes, without taking the appointment's own
    // disclosure with it.
    await page.keyboard.press("Escape");
    await expect(page.locator(".client-contact-ways")).toHaveCount(0);
    await expect(page.locator(".calendar-detail")).toBeVisible();

    await context.close();
  });
});
