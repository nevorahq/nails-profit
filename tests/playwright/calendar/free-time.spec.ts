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
 * What a master could still sell today, as the day view says it.
 *
 * The grid is 08:00–20:00 for everybody, so a column with nothing in it looks
 * identical whether the master is free all day or not working at all. These
 * are the two things that tell them apart: bands over the hours the rota
 * actually covers, and a tally in the column head.
 *
 * The tally is in hours rather than in openings, and deliberately: how many
 * openings a day holds depends on the length of the service being booked into
 * it, and the calendar has no service selected. Twelve hours is twelve hours
 * whatever anybody books.
 *
 * The fixture's rota is 08:00–20:00 — twelve hours — and one 90-minute
 * appointment at 09:00 splits it in two. What is left is 08:00–09:00 and
 * 10:40–20:00: the ten-minute default buffer after an appointment goes with it,
 * because nothing can be booked into a turnaround. That is 620 minutes, which
 * the head reports as 10 rather than 10.5 — hours round down, since twenty
 * spare minutes are not half an hour of anything anybody can sell.
 */
test.describe("free time in the day view", () => {
  let studio: Studio;
  const day = daysFromToday(1);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await requestAppointmentAsClient(baseURL!, studio, { date: day, afterTime: "09:00" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("bands the open hours and counts them in the head", async ({ browser, browserErrors }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto(`/app/calendar?view=day&date=${isoDate(day)}`);

    const column = page.locator(".calendar-column").first();
    await expect(column.locator("h2")).toContainText(studio.specialistName);

    // The whole shift, and what is left of it: 620 minutes, reported down.
    await expect(column.locator(".calendar-tally b")).toHaveText("12");
    await expect(column.locator(".calendar-tally em")).toHaveText("10");
    // Which is two stretches: the hour before, and the rest of the day after.
    await expect(column.locator(".calendar-free")).toHaveCount(2);

    /*
     * A band must not cover the appointment that split it. They share an axis,
     * so an off-by-one in the arithmetic would paint an occupied hour as free
     * and the studio would double-book it.
     */
    const card = await column.locator(".calendar-entry").first().boundingBox();
    for (const band of await column.locator(".calendar-free").all()) {
      const box = await band.boundingBox();
      const overlaps = box!.y < card!.y + card!.height && card!.y < box!.y + box!.height;
      expect(overlaps, "a free band sits over an appointment").toBe(false);
    }

    // The other views are not measured against a rota and say nothing about it.
    await page.goto(`/app/calendar?view=week&date=${isoDate(day)}`);
    await expect(page.locator(".calendar-free")).toHaveCount(0);
    await expect(page.locator(".calendar-tally")).toHaveCount(0);

    await page.goto(`/app/calendar?view=list&date=${isoDate(day)}`);
    await expect(page.locator(".calendar-free")).toHaveCount(0);
    await expect(page.locator(".calendar-tally")).toHaveCount(0);

    await context.close();
  });
});
