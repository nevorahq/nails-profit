import { expect, test } from "../fixtures";
import {
  bookAppointment,
  daysFromToday,
  disposeStudio,
  isoDate,
  moveIntoThePast,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/**
 * «Следующая запись»: a visit closed from the calendar, then «через 3 недели»,
 * then one of the times offered — and the appointment is in the calendar on
 * the day it was booked for, as a confirmed rebooking.
 *
 * At 375 px, because the desk that closes a visit is usually a phone in the
 * master's hand.
 */
test.use({ viewport: { width: 375, height: 812 } });

test.describe("the next appointment, from a closed one", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("close the visit, choose «in 3 weeks», and the booking is in the calendar", async ({
    browser,
    baseURL,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const client = await studio.owner.post<{ id: string }>("/api/v1/clients", {
      name: "Rita Return",
      phone: "+37369111222",
    });
    const booking = await bookAppointment(studio.owner, studio, {
      startsAt: daysFromToday(1),
      clientId: client.id,
    });
    const startsAt = await moveIntoThePast(studio, booking.id);

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`/app/calendar?date=${isoDate(startsAt)}&specialist=${studio.specialistId}`);
    const entry = page.locator(".calendar-entry");
    await expect(entry).toHaveCount(1);
    const card = entry.locator("details").first();
    if (!(await card.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await entry.locator("summary").first().click();
    }

    await entry.getByRole("button", { name: "Close into a visit" }).first().click();
    await expect(entry).toContainText("Completed");

    const next = entry.getByRole("region", { name: "Next appointment" });
    await next.getByRole("button", { name: "In 3 weeks" }).click();
    await expect(next.getByRole("button", { name: "In 3 weeks" })).toHaveAttribute("aria-pressed", "true");

    const firstSlot = next.locator(".next-visit-slots button").first();
    await expect(firstSlot).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("next-visit-slots-375.png"), fullPage: true });
    // Nothing on the card pushes the phone screen sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    await firstSlot.click();
    await expect(next.getByRole("status")).toContainText("Booked for");

    const rebooked = (
      await studio.owner.get<{ id: string; status: string; source: string; starts_at: string }[]>(
        "/api/v1/bookings?status=confirmed",
      )
    ).find((candidate) => candidate.source === "rebooking");
    expect(rebooked?.status).toBe("confirmed");
    const day = new Date(rebooked!.starts_at);
    // Three weeks on or later, never sooner.
    expect(day.getTime()).toBeGreaterThanOrEqual(daysFromToday(20).getTime());

    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    const booked = page.locator(`#booking-${rebooked!.id}`);
    await expect(booked).toContainText("Rita Return");
    await expect(booked).toContainText("Confirmed");
    await page.screenshot({ path: testInfo.outputPath("next-visit-booked-375.png"), fullPage: true });

    // And the report counts it: one visit from the calendar, booked again. The
    // period is named rather than left to the month, which a run just after
    // midnight on the 1st would otherwise split.
    await page.goto(`/app?from=${isoDate(startsAt)}&to=${isoDate(daysFromToday(0))}`);
    const rebook = page.locator(".insight-panel", { hasText: "Repeat bookings" });
    await expect(rebook).toContainText("Booked their next visit");
    await expect(rebook).toContainText("100%");
    await expect(rebook).toContainText("1 of 1 visits from the calendar");
    await page.screenshot({ path: testInfo.outputPath("rebook-rate-375.png"), fullPage: true });

    expect(errors).toEqual([]);
    await context.close();
  });
});
