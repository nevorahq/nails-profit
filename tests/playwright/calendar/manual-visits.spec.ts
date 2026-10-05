import { expect, test } from "../fixtures";
import { disposeStudio, isoDate, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * A visit closed without an appointment, on the calendar.
 *
 * Recorded through «Закрыть визит», it used to exist on `/app/visits` and
 * nowhere on the calendar: the day it happened read «Записей нет». It is drawn
 * among the appointments now, in grey because it is done, on the hours it took
 * — and under the same filters as everything else on the day.
 *
 * Two visits, one per master, the colleague's later: a test that passed by
 * drawing nothing, or by ignoring a filter, still fails. Both are closed now,
 * the way the close form closes one — a commission rule applies from the
 * moment it is set, so a visit backdated past the fixture's rules is refused —
 * and what the calendar should say is worked out from the instants the server
 * recorded.
 */

type Placed = Readonly<{ id: string; day: string; hours: string; withinShift: boolean }>;

/** The fixture's rota, every day: `seedStudio` gives both masters 08:00–20:00. */
const SHIFT = { start: 8 * 60, end: 20 * 60 };

const clock = (instant: Date) => instant.toISOString().slice(11, 16);

/** The fixture's address is in UTC, so its wall clock is the instant's. */
function placed(id: string, completedAt: string, minutes: number): Placed {
  const end = new Date(completedAt);
  const start = new Date(end.getTime() - minutes * 60_000);
  const minuteOf = (instant: Date) => instant.getUTCHours() * 60 + instant.getUTCMinutes();
  return {
    id,
    day: isoDate(start),
    hours: `${clock(start)}–${clock(end)}`,
    withinShift: isoDate(start) === isoDate(end) && minuteOf(start) >= SHIFT.start && minuteOf(end) <= SHIFT.end,
  };
}

test.describe("a visit closed without an appointment", () => {
  let studio: Studio;
  let own: Placed;
  let colleague: Placed;
  // Equal unless the two straddle midnight UTC, which the counts below allow for.
  let together: boolean;
  const calendarOf = (visit: Placed) => `/app/calendar?date=${visit.day}`;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    const first = await studio.owner.post<{ id: string; completed_at: string }>("/api/v1/visits", {
      specialist_id: studio.specialistId,
      service_id: studio.serviceId,
      actual_duration_minutes: 90,
    });
    own = placed(first.id, first.completed_at, 90);
    const second = await studio.owner.post<{ id: string; completed_at: string }>("/api/v1/visits", {
      specialist_id: studio.colleagueId,
      service_id: studio.serviceId,
      actual_duration_minutes: 1,
    });
    colleague = placed(second.id, second.completed_at, 1);
    together = own.day === colleague.day;
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("is listed on its day, in grey, on the hours it took, and opens to the visit", async ({
    baseURL,
    browser,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(calendarOf(own));

    const entries = page.locator(".calendar-daylist .calendar-entry.is-visit");
    await expect(entries).toHaveCount(together ? 2 : 1);
    await expect(page.locator(".calendar-daylist")).not.toContainText("Nothing booked.");
    // Ended when it was closed, began its length before; first in the day.
    const entry = page.locator(`#visit-${own.id}`);
    await expect(entries.first()).toHaveAttribute("id", `visit-${own.id}`);
    await expect(entry.locator(".calendar-time")).toHaveText(own.hours);
    await expect(entry).toContainText(studio.specialistName);

    // The hours it took are not offered as free ones — which can only show
    // when the visit fell inside the rota. Closed «now», it does only while
    // the suite runs between 09:30 and 20:00 UTC; outside that the tally has
    // nothing of it to subtract, and saying so would be the wrong claim.
    if (own.withinShift) {
      const tally = (await page.locator(".calendar-tally").textContent()) ?? "";
      const [shiftHours, freeHours] = (tally.match(/[\d.,]+/g) ?? []).map((n) => Number(n.replace(",", ".")));
      expect(freeHours).toBeLessThan(shiftHours);
    }

    // Grey, and the month's cell carries a mark for each visit of the day.
    await expect(entry).toHaveCSS("background-color", "rgb(236, 238, 234)");
    const cell = page.locator(`.calendar-cell[href*="date=${own.day}"]`);
    await expect(cell.locator(".calendar-mark.status-visit")).toHaveCount(together ? 2 : 1);

    // A card that opens, to the visit itself.
    await entry.locator("summary").click();
    const link = entry.getByRole("link", { name: "Open the visit" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", `/app/visits?visit=${own.id}`);
    await page.screenshot({ path: testInfo.outputPath("calendar-manual-visit.png"), fullPage: true });

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/app/visits\\?visit=${own.id}`));
    await expect(page.locator(".visit-card")).toHaveCount(1);
    await expect(page.locator(`#visit-${own.id} > details.visit-card-details`)).toHaveAttribute("open", "");

    await context.close();
  });

  test("answers to the calendar's filters", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    const visitsOn = async (query: string) => {
      await page.goto(`${calendarOf(colleague)}${query}`);
      return page.locator(".calendar-daylist .calendar-entry.is-visit");
    };
    const onColleaguesDay = together ? 2 : 1;

    // The master select on the bar.
    await page.goto(calendarOf(colleague));
    await page.getByRole("combobox", { name: "Specialist" }).selectOption(studio.colleagueId);
    await expect(page).toHaveURL(new RegExp(`specialist=${studio.colleagueId}`));
    const narrowed = page.locator(".calendar-daylist .calendar-entry.is-visit");
    await expect(narrowed).toHaveCount(1);
    await expect(narrowed).toHaveAttribute("id", `visit-${colleague.id}`);
    await expect(narrowed.locator(".calendar-time")).toHaveText(colleague.hours);

    // A visit closed by hand is what `completed` means, and no other status.
    await expect(await visitsOn("&status=completed")).toHaveCount(onColleaguesDay);
    await expect(await visitsOn("&status=confirmed")).toHaveCount(0);

    // An address its masters work at keeps it; one they do not, does not.
    await expect(await visitsOn(`&location=${studio.locationId}`)).toHaveCount(onColleaguesDay);
    await expect(await visitsOn("&location=00000000-0000-0000-0000-000000000000")).toHaveCount(0);

    await context.close();
  });

  test("shows a master their own and not a colleague's", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.master, baseURL!);
    const page = await context.newPage();

    await page.goto(calendarOf(colleague));
    await expect(page.locator(`#visit-${colleague.id}`)).toHaveCount(0);
    await page.goto(calendarOf(own));
    await expect(page.locator(".calendar-daylist .calendar-entry.is-visit")).toHaveCount(1);
    await expect(page.locator(`#visit-${own.id} .calendar-time`)).toHaveText(own.hours);

    // And the permalink keeps the scope: a colleague's visit is not opened.
    await page.goto(`/app/visits?visit=${colleague.id}`);
    await expect(page.locator(".visit-card")).toHaveCount(0);

    await context.close();
  });
});
