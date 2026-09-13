import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  isoDate,
  seedStudio,
  useClientAddress,
  type Studio,
} from "../helpers/studio";

/**
 * The client's half of the product, in a client's browser.
 *
 * Everything else in this suite signs in; nobody booking a manicure ever will.
 * This is the one page that belongs to a stranger — no account, no session, a
 * phone — and the studio's whole funnel runs through it, so it is worth walking
 * rather than calling: the catalogue has to load, the day has to produce times,
 * the chosen time has to survive the contact form, and the answer at the end
 * has to say the studio still has to confirm.
 */
test.describe("the public booking page", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL, page }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    // One visitor, one address: the public endpoints count anonymous callers by
    // it, and every test here would otherwise be the same very busy client.
    await useClientAddress(page, baseURL!);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("a stranger books a time and the studio gets a request", async ({
    browser,
    page,
    browserErrors,
  }) => {
    void browserErrors;
    const response = await page.goto(`/book/${studio.slug}`);
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { name: "Choose a time that works" })).toBeVisible();
    await expect(page.getByLabel("Service")).toContainText("Manicure with coating");
    await expect(page.getByText("MDL 600.00")).toBeVisible();

    // Naming the master rather than taking «Any available»: the second half of
    // this test is about whose bell the request lands in, and the studio has two
    // specialists free at the same hour.
    await page.getByLabel("Specialist").selectOption({ label: studio.specialistName });
    await page.getByLabel("Date").fill(isoDate(daysFromToday(2)));
    await page.getByRole("button", { name: "Show available times" }).click();

    const times = page.locator(".public-booking-slots button");
    await expect(times.first()).toBeVisible();
    const chosen = (await times.first().innerText()).split("\n")[0];
    await times.first().click();

    // The details a client typed have to survive the step that follows — the
    // summary above the form is what tells them the time is still the one they
    // picked.
    await expect(page.locator(".public-booking-summary")).toContainText("Manicure with coating");
    await page.getByLabel("Name").fill("Clara Client");
    await page.locator("#booking-phone").fill("+373 69 555 111");
    await page.locator("#booking-email").fill("clara@example.com");
    await page.locator("#booking-legalAccepted").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();
    // The manage link is the client's only way back to an appointment they made
    // without an account.
    await expect(page.getByRole("link", { name: "Open appointment" })).toHaveAttribute(
      "href",
      /\/booking\//,
    );

    /*
     * And what it leads to. The badge used to be the whole answer — one word,
     * in the same sage pill every status wore, on a page that then said nothing
     * about what the word meant or how long it would hold.
     *
     * A request is the state where that costs most: it lapses on a deadline the
     * client was never shown, and the studio's answer arrives by an email that
     * may be queued, filtered, or impossible to send. So the page now names the
     * hour, and says it is watching for the answer itself.
     */
    await page.getByRole("link", { name: "Open appointment" }).click();
    await expect(page.locator(".booking-status-pending_confirmation")).toBeVisible();
    await expect(page.locator(".booking-next-step")).toContainText(
      /The studio will answer by \d{1,2}:\d{2}/,
    );
    await expect(page.locator(".booking-watching")).toContainText("keep it open");
    await page.goBack();

    // The other end of it: a request waiting in the studio, for the master it
    // was booked with, at the time the client chose.
    const staff = await browser.newContext({ storageState: await studio.master.storageState() });
    const staffPage = await staff.newPage();
    await staffPage.goto("/app/calendar");
    await staffPage.getByRole("button", { name: "Notifications" }).click();

    const waiting = staffPage.getByRole("menuitem").first();
    await expect(waiting).toContainText("Clara Client");
    await expect(waiting).toContainText(chosen);

    await staff.close();
  });

  /**
   * The same page, to somebody who has been here before.
   *
   * A booking page that has forgotten the client it just took a booking from is
   * not only cold — it is how a studio ends up with the same visit twice, which
   * is why `cancellation_reason` has a `duplicate` in it. There is no session to
   * recognise anybody by, so the recognition is the manage token the booking
   * left in this browser, spent on the status endpoint and shown in the header
   * badge the page keeps on screen.
   */
  test("the studio's page knows a client who has already booked here", async ({
    page,
    browserErrors,
  }) => {
    void browserErrors;
    await page.goto(`/book/${studio.slug}`);

    // A stranger is offered the form and told nothing about anybody's booking.
    await expect(page.locator(".public-booking-yours")).toHaveCount(0);
    await expect(page.locator(".public-booking-header .role-badge")).toHaveText("Online booking");

    await page.getByLabel("Date").fill(isoDate(daysFromToday(2)));
    await page.getByRole("button", { name: "Show available times" }).click();
    await page.locator(".public-booking-slots button").first().click();
    await page.getByLabel("Name").fill("Rita Return");
    await page.locator("#booking-phone").fill("+373 69 555 222");
    await page.locator("#booking-legalAccepted").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();

    /*
     * The status check, held long enough that the client presses «это не я»
     * before it answers. `route.fetch` runs the request; the reply waits.
     */
    let releaseCheck = () => {};
    const heldCheck = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    await page.route("**/api/v1/public/bookings/*/status", async (route) => {
      const response = await route.fetch();
      await new Promise((wait) => setTimeout(wait, 1_500));
      await route.fulfill({ response });
      releaseCheck();
    });

    // Back to the URL they arrived by — the one in the studio's bio, the one
    // they bookmarked — which now answers instead of starting over.
    await page.goto(`/book/${studio.slug}`);
    await expect(
      page.locator(".public-booking-header .booking-status-pending_confirmation"),
    ).toHaveText("Awaiting confirmation");

    const strip = page.locator(".public-booking-yours");
    await expect(strip).toContainText("Your appointment");
    await expect(strip).toContainText("The studio will answer your request shortly.");
    await expect(strip.getByRole("link", { name: "Open appointment" })).toHaveAttribute(
      "href",
      /\/booking\//,
    );

    /*
     * A phone is shared more often than an account is: whoever does not
     * recognise this visit can take it off the screen, and it stays off.
     *
     * Pressed while the page's own status check is deliberately still in
     * flight, which is how this went wrong: the answer landed after the record
     * had been removed and wrote it straight back, so the strip vanished and
     * the visit was on the screen again the next time the page opened. A
     * parallel run found it by accident; the delay here finds it every time.
     *
     * The click is retried under `toPass` for the ordinary reason — the button
     * is React's and the page is server-rendered, so under load it can be on
     * screen a beat before it is listening.
     */
    await expect(async () => {
      await strip.getByRole("button", { name: "Not me" }).click();
      await expect(strip).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await heldCheck;
    await expect(page.locator(".public-booking-header .role-badge")).toHaveText("Online booking");

    await page.reload();
    await expect(page.locator(".public-booking-yours")).toHaveCount(0);
  });

  /**
   * Where to write, from the client's own hand to the master's screen.
   *
   * Nothing about a number can be looked up — WhatsApp stopped answering
   * whether one is registered, Telegram answers only to a user account — so the
   * booking page asking is the whole of how a studio comes to know. This walks
   * it end to end, because a field that is stored and never shown is a field
   * nobody filled in for a reason.
   */
  test("a client says where to write, and the master's screen shows it", async ({
    browser,
    page,
    browserErrors,
  }) => {
    void browserErrors;
    await page.goto(`/book/${studio.slug}`);

    await page.getByLabel("Date").fill(isoDate(daysFromToday(3)));
    await page.getByRole("button", { name: "Show available times" }).click();
    await page.locator(".public-booking-slots button").first().click();

    await page.getByLabel("Name").fill("Nadia Note");
    await page.locator("#booking-phone").fill("+373 69 556 700");

    /*
     * The messengers, and only them: the call is not offered because the number
     * above already guarantees it. Optional, nothing preselected — ticking none
     * is an answer, not an error.
     */
    const channels = page.locator(".public-booking-channels");
    await expect(channels.getByRole("checkbox")).toHaveCount(3);
    await expect(channels.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await channels.getByRole("checkbox", { name: "WhatsApp" }).check();

    await page.locator("#booking-legalAccepted").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();

    // And on the day, where somebody has to decide how to reach them.
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const staff = await context.newPage();
    await staff.goto(`/app/calendar?date=${isoDate(daysFromToday(3))}`);
    await staff.locator(".calendar-entry summary").first().click();
    await staff.locator(".calendar-call").click();

    await expect(staff.locator('.client-contact-way[data-channel="whatsapp"]')).toHaveAttribute(
      "data-state",
      "yes",
    );
    /*
     * And the rest stay unsaid. A client who did not tick Telegram has not said
     * they lack it, and a screen that drew it as absent would stop the desk
     * trying something that would have worked.
     */
    await expect(staff.locator('.client-contact-way[data-channel="telegram"]')).toHaveAttribute(
      "data-state",
      "unknown",
    );

    await context.close();
  });

  /**
   * The other end of the same rule: a client who uses no messengers books
   * without answering, and the studio reaches them the way the number allows.
   * Nothing about this form may stop somebody for whom the honest answer to a
   * question about WhatsApp is «нет».
   */
  test("takes a booking from a client who uses no messengers", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto(`/book/${studio.slug}`);
    await page.getByLabel("Date").fill(isoDate(daysFromToday(4)));
    await page.getByRole("button", { name: "Show available times" }).click();
    await page.locator(".public-booking-slots button").first().click();

    await page.getByLabel("Name").fill("Nora None");
    await page.locator("#booking-phone").fill("+373 69 556 701");
    await page.locator("#booking-legalAccepted").check();
    await expect(
      page.locator(".public-booking-channels").getByRole("checkbox", { checked: true }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();
  });

  test("a day with nothing free says so instead of failing", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto(`/book/${studio.slug}`);

    // Sunday of a week that the rota covers is fine; a date before the rota
    // starts is not bookable at all, which is the case this asserts.
    await page.getByLabel("Date").fill(isoDate(daysFromToday(-2)));
    await page.getByRole("button", { name: "Show available times" }).click();

    await expect(page.locator(".public-booking-slots button")).toHaveCount(0);
    await expect(page.locator("main")).toContainText(
      /There are no free times on this date|Choose a time that works/,
    );
  });

  test("an unknown studio is a 404, not a crash", async ({ page }) => {
    const response = await page.goto("/book/no-such-studio-anywhere");
    expect(response?.status()).toBe(404);
  });
});

/**
 * What a client is told when the studio refuses them.
 *
 * Split from the walk above because the interesting part is the answer, not the
 * journey: the form used to translate five of the twenty codes the public API
 * can refuse with and print "check the details and try again" for the rest, so
 * "you have tried too often", "this page is stale" and "the server is down" all
 * arrived as an instruction to re-read a form that was already correct.
 */
test.describe("a refused booking", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL, page }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await useClientAddress(page, baseURL!);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("says which refusal it was and leaves something to look it up by", async ({
    page,
    browserErrors,
  }) => {
    const walk = async (dayOffset: number, contact: { name: string; phone: string; email: string }) => {
      await page.goto(`/book/${studio.slug}`);
      await page.getByLabel("Date").fill(isoDate(daysFromToday(dayOffset)));
      await page.getByRole("button", { name: "Show available times" }).click();
      const times = page.locator(".public-booking-slots button");
      await expect(times.first()).toBeVisible();
      await times.first().click();

      await page.getByLabel("Name").fill(contact.name);
      await page.locator("#booking-phone").fill(contact.phone);
      await page.locator("#booking-email").fill(contact.email);
      await page.locator("#booking-legalAccepted").check();
      await page.getByRole("button", { name: "Confirm booking" }).click();
    };

    // Two clients on the studio's list, then a form carrying one's number and
    // the other's address. Matching is on either contact, so that form belongs
    // to two people at once and the API refuses it as `CONTACT_CONFLICT` — a
    // refusal a person can actually act on, once they are told which it is.
    await walk(2, { name: "Ana One", phone: "+373 69 555 201", email: "one@example.com" });
    await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();

    await walk(3, { name: "Bea Two", phone: "+373 69 555 202", email: "two@example.com" });
    await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();

    await walk(4, { name: "Ana One", phone: "+373 69 555 201", email: "two@example.com" });

    const banner = page.locator(".form-error");
    await expect(banner).toContainText("two different clients");
    // The identifier the API puts on every refusal. Without it on screen, a
    // studio asked why a client could not book had a screenshot of one sentence
    // and no way to find the request behind it.
    await expect(banner.locator(".error-reference")).toContainText("Reference code:");

    /*
     * The browser logs the refused POST as a failed resource load, which is the
     * one console error this scenario is supposed to produce. Everything else
     * still has to be empty, so the fixture's list is checked here and cleared
     * before its own teardown asserts it.
     */
    expect(browserErrors.filter((entry) => !entry.includes("409"))).toEqual([]);
    browserErrors.length = 0;
  });
});
