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
 * «Свои записи» as a screen rather than as a policy.
 *
 * Section 6.1 gives a Master the `bookings` capability at scope "own", and
 * `lib/booking-access.ts` narrows every endpoint to the specialist row carrying
 * their account. That narrowing is worth testing where it is actually relied
 * on: two appointments on one day, one theirs and one a colleague's, and a
 * master who must see exactly one of them — in the calendar, in the bell, and
 * from the API even when they know the other's id.
 *
 * The colleague's appointment is deliberately later in the day, so a test that
 * passed by rendering nothing at all would still fail.
 */
test.describe("a master sees their own calendar and no further", () => {
  let studio: Studio;
  let day: Date;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    day = daysFromToday(1);
    await requestAppointmentAsClient(baseURL!, studio, { date: day, name: "Own Client" });
    await requestAppointmentAsClient(baseURL!, studio, {
      date: day,
      specialistId: studio.colleagueId,
      name: "Colleague Client",
      afterTime: "13:00",
    });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("the day shows one appointment to the master and two to the owner", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const url = `/app/calendar?view=day&date=${isoDate(day)}`;

    const masterContext = await browser.newContext({
      storageState: await studio.master.storageState(),
    });
    const masterPage = await masterContext.newPage();
    await masterPage.goto(url);

    await expect(masterPage.locator(".calendar-entry")).toHaveCount(1);
    await expect(masterPage.locator(".calendar-entry")).toContainText("Own Client");
    // The day itself, not the whole page: the compose form below it is a
    // separate matter, and one the test after this one is about.
    await expect(masterPage.locator(".calendar-entry")).not.toContainText("Colleague Client");
    // A calendar that is only ever theirs has nothing to choose between, so the
    // filter panel offers no specialist. (The compose form below still names
    // one — a booking has to be made for somebody — but only ever them.)
    const masterFilters = masterPage.locator("details.calendar-filters");
    await expect(masterFilters).toBeVisible();
    await expect(masterFilters.getByLabel("Specialist")).toHaveCount(0);
    // Present but folded away: the panel is a `details`, closed by default.
    await expect(masterFilters.getByLabel("Status")).toHaveCount(1);

    const ownerContext = await browser.newContext({
      storageState: await studio.owner.storageState(),
    });
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(url);

    await expect(ownerPage.locator(".calendar-entry")).toHaveCount(2);
    await expect(ownerPage.locator("main")).toContainText("Own Client");
    await expect(ownerPage.locator("main")).toContainText("Colleague Client");

    // And the owner can narrow to one person, which is the filter the master is
    // not offered because it would only ever have one answer.
    await ownerPage.goto(`${url}&specialist=${studio.colleagueId}`);
    await expect(ownerPage.locator(".calendar-entry")).toHaveCount(1);
    await expect(ownerPage.locator(".calendar-entry")).toContainText("Colleague Client");

    await masterContext.close();
    await ownerContext.close();
  });

  /**
   * A gap this suite found, not a test that has ever passed.
   *
   * The appointments on a master's calendar are narrowed to their own, and the
   * specialist select is withheld — but the «Новая запись» form below carries a
   * client picker built from an unscoped query: `roster` in
   * `app/app/calendar/page.tsx` reads every client the studio has, while
   * `app/app/clients/page.tsx` narrows the same people to the ones the master
   * has actually worked with. So a master is shown, by name, the studio's whole
   * client list on a screen whose scope is «свои записи» — section 6.1's
   * «только назначенные клиенты».
   *
   * Whether the picker should scope or the section should widen is a product
   * decision; that the two screens disagree is not.
   */
  test.fixme("the client picker offers a master only the clients they have worked with", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();
    await page.goto(`/app/calendar?view=day&date=${isoDate(day)}`);

    const picker = page.locator("#new-booking select[name='client_id'], #new-booking select").last();
    await expect(picker).not.toContainText("Colleague Client");

    await context.close();
  });

  test("the bell carries only the master's own requests", async ({ browser, browserErrors }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");
    await page.getByRole("button", { name: "Notifications" }).click();

    const items = page.getByRole("menuitem");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Own Client");

    await context.close();
  });

  test("knowing a colleague's booking id is not access to it", async ({ baseURL }, testInfo) => {
    const colleagueBooking = await requestAppointmentAsClient(baseURL!, studio, {
      date: daysFromToday(2),
      specialistId: studio.colleagueId,
      name: "Another Client",
    });

    // 404 rather than 403 on purpose: an id that answers «forbidden» has
    // confirmed the appointment exists.
    const refused = await studio.master.request.post(
      `/api/v1/bookings/${colleagueBooking.id}/confirm`,
      { data: {} },
    );
    expect(refused.status()).toBe(404);
    expect((await refused.json()).error.code).toBe("BOOKING_NOT_FOUND");

    // And the same appointment, from another studio entirely.
    const stranger = await seedStudio(baseURL!, testInfo);
    try {
      const crossTenant = await stranger.owner.request.get(
        `/api/v1/bookings/${colleagueBooking.id}`,
      );
      expect(crossTenant.status()).toBe(404);
    } finally {
      await disposeStudio(stranger);
    }
  });
});
