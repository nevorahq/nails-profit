import { eq } from "drizzle-orm";

import { bookings } from "@/db/schema";

import { adminDb, closeTestConnections } from "../../helpers/database";
import { expect, test } from "../fixtures";
import {
  atTime,
  bookAppointment,
  daysFromToday,
  disposeStudio,
  isoDate,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/**
 * «Сдвинуть следующие записи» on the card of a visit that is running late.
 *
 * The panel is offered for today's appointments only, and the API will not
 * book into the past, so the two appointments are made for tomorrow — where the
 * rota is open whatever the hour the suite runs at — and brought to today in the
 * table. A delay is what is tested: pushing later does not depend on the clock,
 * where pulling earlier is refused for any time that has already gone by.
 */
test.describe("shifting the rest of the day", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test.afterAll(async () => {
    await closeTestConnections();
  });

  async function twoAppointmentsToday() {
    const anchor = await bookAppointment(studio.owner, studio, {
      startsAt: atTime(daysFromToday(1), "09:00"),
    });
    const next = await bookAppointment(studio.owner, studio, {
      startsAt: atTime(daysFromToday(1), "10:30"),
    });

    for (const [id, time] of [
      [anchor.id, "09:00"],
      [next.id, "10:30"],
    ] as const) {
      const startsAt = atTime(daysFromToday(0), time);
      await adminDb
        .update(bookings)
        .set({ startsAt, endsAt: new Date(startsAt.getTime() + 90 * 60_000) })
        .where(eq(bookings.id, id));
    }

    return { anchor, next };
  }

  test("a delay is previewed, then pushes the next appointment and says so", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const { anchor, next } = await twoAppointmentsToday();

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(daysFromToday(0))}&specialist=${studio.specialistId}`);

    const entry = page.locator(`#booking-${anchor.id}`);
    await entry.locator("summary").first().click();

    const panel = entry.locator("details.shift-following");
    await panel.locator("summary").click();
    await panel.getByLabel("Later").check();
    await panel.getByLabel("By how many minutes").fill("15");
    await panel.getByRole("button", { name: "Show what would move" }).click();

    // Seen before it is done: one line, 10:30 to 10:45.
    const preview = panel.locator(".shift-preview");
    await expect(preview).toContainText("These will move");
    await expect(preview.locator("li")).toHaveCount(1);
    await expect(preview).toContainText("10:30");
    await expect(preview).toContainText("10:45");
    expect((await studio.owner.get<{ starts_at: string }>(`/api/v1/bookings/${next.id}`)).starts_at).toContain(
      "T10:30:00",
    );

    await preview.getByRole("button", { name: /^Move 1 and tell the clients/ }).click();
    await expect(panel).toContainText("Done, appointments moved: 1");

    const moved = await studio.owner.get<{ starts_at: string }>(`/api/v1/bookings/${next.id}`);
    expect(moved.starts_at).toContain("T10:45:00");

    // Nothing on the card pushes the phone screen sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await context.close();
  });

  test("freeing more time than the visit lasted is refused, with the reason", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    const { anchor } = await twoAppointmentsToday();

    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(daysFromToday(0))}&specialist=${studio.specialistId}`);

    const entry = page.locator(`#booking-${anchor.id}`);
    await entry.locator("summary").first().click();
    const panel = entry.locator("details.shift-following");
    await panel.locator("summary").click();
    // The visit was booked for an hour and a half: two hours cannot have been freed.
    await panel.getByLabel("Earlier").check();
    await panel.getByLabel("By how many minutes").fill("120");
    await panel.getByRole("button", { name: "Show what would move" }).click();

    await expect(panel.getByRole("alert")).toContainText("Not that much earlier");
    await expect(panel.locator(".shift-preview")).toHaveCount(0);
    await context.close();
  });
});
