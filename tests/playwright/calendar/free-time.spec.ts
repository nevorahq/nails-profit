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
 * What the studio could still sell on the day the list is showing.
 *
 * The list is one run of appointments in time order, so nothing in its shape
 * says whether the hours between them are hours somebody works. These two
 * figures are what say it: the rota the day holds, and how much of that rota
 * nothing stands in.
 *
 * They are hours rather than openings, deliberately: how many openings a day
 * holds depends on the length of the service being booked into it, and the
 * calendar has no service selected. Twelve hours is twelve hours whatever
 * anybody books.
 *
 * The fixture gives both masters a 08:00–20:00 rota — twelve hours each — and
 * one 90-minute appointment at 09:00 splits Mara's in two. What is left of hers
 * is 08:00–09:00 and 10:40–20:00: the ten-minute default buffer after an
 * appointment goes with it, because nothing can be booked into a turnaround.
 * That is 620 minutes, reported as 10 rather than 10.5 — hours round down,
 * since twenty spare minutes are not half an hour of anything anybody can sell.
 */
test.describe("the hours left in the listed day", () => {
  let studio: Studio;
  const day = daysFromToday(1);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await requestAppointmentAsClient(baseURL!, studio, { date: day, afterTime: "09:00" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  /**
   * The figure an owner reads is the studio's, and a studio is more than one
   * person. Two masters free from 10:00 to 11:00 is an hour that can be sold
   * twice — so the arithmetic is done per master and only then added up, and
   * this is the assertion that catches it being done the cheap way instead. A
   * merged rota would report the owner 12 and 10, the same as the master below.
   */
  test("adds up what every master has left", async ({ browser, browserErrors }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?date=${isoDate(day)}`);

    // Two twelve-hour rotas, less the appointment and its turnaround — and the
    // words, which is the whole line rather than a pair of numbers now.
    await expect(page.locator(".calendar-daylist .calendar-tally")).toHaveText(
      "Shift 24 h · free 22 h",
    );

    await context.close();
  });

  test("is one master's own day when the calendar is one master's", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?date=${isoDate(day)}`);

    await expect(page.locator(".calendar-daylist .calendar-tally")).toHaveText(
      "Shift 12 h · free 10 h",
    );

    /*
     * And their own name is not printed on their own appointment. A studio's
     * list needs it on every card — there is no column heading to carry it any
     * more — but a Master's calendar is theirs by construction, so it would be
     * one line of noise per row.
     */
    await expect(page.locator(".calendar-entry .calendar-master")).toHaveCount(0);

    await context.close();
  });

  /**
   * A day nobody works has no tally at all, rather than a tally of zero. «0 / 0»
   * is what a fully booked day looks like too, and the two are opposite facts.
   */
  test("says nothing about a day outside every rota", async ({ browser, browserErrors }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    // The rota starts yesterday, so any date before that is a day the studio
    // had not yet said it works.
    await page.goto(`/app/calendar?date=${isoDate(daysFromToday(-30))}`);

    await expect(page.locator(".calendar-daylist")).toContainText("Nothing booked.");
    await expect(page.locator(".calendar-tally")).toHaveCount(0);

    await context.close();
  });
});
