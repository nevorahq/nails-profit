import { expect, test } from "../fixtures";
import { chooseService, typeNewClient } from "../helpers/booking-form";
import {
  daysFromToday,
  disposeStudio,
  isoDate,
  requestAppointmentAsClient,
  seedStudio,
  signedInContext,
  type Studio,
  untilRevealed,
} from "../helpers/studio";

/**
 * The day's list shows the openings between the appointments, and an opening
 * is a way in to a new one.
 *
 * The fixture rota is 08:00–20:00 UTC for both masters and the service runs
 * ninety minutes. One appointment stands at 09:00 on the day under test: it
 * takes 09:00–10:30 and the ten-minute turnaround after it. What is left of the
 * first master's day is 08:00–09:00 and 10:40–20:00 — the same two windows the
 * tally on this page adds up — and the second master's day is one window, the
 * whole of it.
 *
 * The windows are cut into slots of the address's step, which the fixture leaves
 * at the default hour, counted from where each window begins: 08:00–09:00 is one
 * slot, 10:40–20:00 is nine (the last 20 minutes make no whole hour), and the
 * second master's twelve hours are twelve.
 */
test.describe("openings in the day's list", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    await requestAppointmentAsClient(baseURL!, studio, { date: day, afterTime: "09:00", name: "Booked First" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  async function openDay(
    browser: Parameters<typeof signedInContext>[0],
    baseURL: string,
    query = `&specialist=${studio?.specialistId}`,
    date = day,
  ) {
    const context = await signedInContext(browser, studio.owner, baseURL);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(date)}${query}`);
    await untilRevealed(page);
    return { context, page };
  }

  test("stand between the appointments, in the order of the clock", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openDay(browser, baseURL!);

    const items = page.locator(".calendar-list > li");
    await expect(items).toHaveCount(11);
    await expect(items.nth(0)).toHaveClass(/calendar-free/);
    await expect(items.nth(0)).toContainText("08:00–09:00");
    // The appointment is the card it always was.
    await expect(items.nth(1)).toHaveClass(/calendar-entry/);
    await expect(items.nth(1)).toContainText("09:00");
    // Then the rest of the day, an hour at a time from where it begins.
    await expect(items.nth(2)).toHaveClass(/calendar-free/);
    await expect(items.nth(2)).toContainText("10:40–11:40");
    await expect(items.nth(3)).toContainText("11:40–12:40");
    await expect(items.nth(10)).toContainText("18:40–19:40");

    await context.close();
  });

  test("are dashed and yellow, and carry a plus", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openDay(browser, baseURL!);

    const slot = page.locator(".calendar-free-slot").first();
    const style = await slot.evaluate((node) => {
      const computed = getComputedStyle(node);
      return { style: computed.borderTopStyle, color: computed.borderTopColor };
    });
    expect(style.style).toBe("dashed");
    // `--free-hour-edge`, #dcc07a: yellow, not the grey or green of anything else on the list.
    expect(style.color).toBe("rgb(220, 192, 122)");
    await expect(slot.locator(".calendar-free-plus svg")).toBeVisible();

    // A control, so it is named for what it does rather than for what it is.
    await expect(page.getByRole("button", { name: "Add an appointment for 08:00–09:00" })).toBeVisible();

    await context.close();
  });

  test("are rounded exactly as the appointment beside them", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openDay(browser, baseURL!);

    const radius = (selector: string) =>
      page.locator(selector).first().evaluate((node) => getComputedStyle(node).borderTopLeftRadius);
    const booked = await radius(".calendar-entry");
    expect(booked).not.toBe("0px");
    expect(await radius(".calendar-free-slot")).toBe(booked);

    await context.close();
  });

  test("open the appointment window on that master, that day and that time", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openDay(browser, baseURL!);

    await page.getByRole("button", { name: "Add an appointment for 10:40–11:40" }).click();
    const dialog = page.getByRole("dialog", { name: "New appointment" });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByLabel("Date")).toHaveValue(isoDate(day));
    // The master is answered, so the form is already past asking who.
    await expect(dialog).toContainText(studio.specialistName);
    await expect(dialog.getByRole("checkbox", { name: /^Manicure with coating/ })).toBeVisible();
    // The start of the opening is the time, lit — whether or not the grid has it.
    await expect(dialog.getByRole("button", { name: "10:40", exact: true })).toHaveAttribute("aria-pressed", "true");

    await context.close();
  });

  test("are drawn per master on the studio's day, each naming whose it is", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openDay(browser, baseURL!, "");

    // Ten for the master with an appointment, twelve — the whole day — for the other.
    await expect(page.locator(".calendar-free-slot")).toHaveCount(22);
    await expect(page.locator(".calendar-free-slot", { hasText: studio.colleagueName })).toHaveCount(12);
    await expect(page.locator(".calendar-free-slot", { hasText: studio.specialistName })).toHaveCount(10);
    await expect(page.locator(".calendar-free-slot", { hasText: "10:40–11:40" })).toContainText(studio.specialistName);

    // Pressing the other master's opening books the other master.
    await page.locator(".calendar-free-slot", { hasText: studio.colleagueName }).first().click();
    const dialog = page.getByRole("dialog", { name: "New appointment" });
    await expect(dialog).toContainText(studio.colleagueName);

    await context.close();
  });

  /**
   * A new card is written with a default week at every address the studio has,
   * before anybody has said where the master works — here the studio's first
   * address, where nobody is placed, 08:00–16:00 on weekdays. An opening drawn
   * there would send the desk to an address the master is not at; it would also
   * make every other assertion in this file depend on the weekday it runs on.
   */
  test("are only at the addresses the master is placed at, and name the address", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    // A weekday, which is when the default week applies.
    const weekday = [1, 2, 3, 4, 5, 6, 7].map((offset) => daysFromToday(offset)).find((date) => {
      const index = date.getUTCDay();
      return index >= 1 && index <= 5;
    })!;
    const { context, page } = await openDay(browser, baseURL!, "", weekday);

    // Twelve hours each at «Central» — not the default week's eight at the other address as well.
    await expect(page.locator(".calendar-free-slot")).toHaveCount(24);
    await expect(page.locator(".calendar-free-slot", { hasText: "Central" })).toHaveCount(24);
    await expect(page.locator(".calendar-free-slot", { hasText: "19:00–20:00" })).toHaveCount(2);

    await context.close();
  });

  test("are not drawn for a day that is over", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    // The rota starts yesterday: a day it covers, and one nobody can be booked into any more.
    const { context, page } = await openDay(browser, baseURL!, "", daysFromToday(-1));

    await expect(page.locator(".calendar-free-slot")).toHaveCount(0);

    await context.close();
  });

  test("are not drawn while the list is narrowed by status", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    // The appointments standing in a gap may be exactly the ones filtered out.
    const { context, page } = await openDay(browser, baseURL!, `&status=cancelled`);

    await expect(page.locator(".calendar-free-slot")).toHaveCount(0);

    await context.close();
  });

  test("are a Master's own, without their name on them", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.master, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}`);
    await untilRevealed(page);

    await expect(page.locator(".calendar-free-slot")).toHaveCount(10);
    await expect(page.locator(".calendar-free-slot .calendar-master")).toHaveCount(0);

    await context.close();
  });
});

/**
 * Its own studio: booking into an opening changes the day for every test that
 * reads it, and these share nothing with the ones above.
 */
test.describe("booking into an opening", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    await requestAppointmentAsClient(baseURL!, studio, { date: day, afterTime: "09:00", name: "Booked First" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  async function openOwnersDay(browser: Parameters<typeof signedInContext>[0], baseURL: string) {
    const context = await signedInContext(browser, studio.owner, baseURL);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    await untilRevealed(page);
    return { context, page };
  }

  test("book into the opening, and the opening gives way to the appointment", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openOwnersDay(browser, baseURL!);

    await page.getByRole("button", { name: "Add an appointment for 10:40–11:40" }).click();
    const dialog = page.getByRole("dialog", { name: "New appointment" });
    await chooseService(dialog, "Manicure with coating");
    await typeNewClient(dialog, "From An Opening");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.locator(".calendar-entry", { hasText: "From An Opening" })).toBeVisible();
    // 10:40–12:10 and its turnaround are taken; the opening begins where they end.
    await expect(page.locator(".calendar-free-slot", { hasText: "10:40" })).toHaveCount(0);
    await expect(page.locator(".calendar-free-slot", { hasText: "12:20–13:20" })).toBeVisible();

    await context.close();
  });
});

/**
 * The step is the address's own setting, and the list follows it: the same
 * place for the same time as the public page offers. Its own studio, because it
 * changes a setting every other test reads.
 */
test.describe("the step the openings are cut by", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    await studio.owner.put(`/api/v1/locations/${studio.locationId}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
      max_advance_days: 90,
      confirmation_ttl_minutes: 1_440,
      slot_step_minutes: 90,
    });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("cuts a master's twelve hours into eight slots of an hour and a half", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    await untilRevealed(page);

    const slots = page.locator(".calendar-free-slot");
    await expect(slots).toHaveCount(8);
    await expect(slots.nth(0)).toContainText("08:00–09:30");
    await expect(slots.nth(7)).toContainText("18:30–20:00");

    await context.close();
  });
});

/**
 * Blocking time lives with the working hours now, and the calendar only shows
 * what was blocked. Its own studio: it writes a block, and a block is exactly
 * what would change the other tests' openings.
 */
test.describe("blocking time", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("is no longer a panel on the calendar", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}`);
    await untilRevealed(page);

    await expect(page.getByRole("heading", { name: "Block time" })).toHaveCount(0);

    await context.close();
  });

  test("is done beside the working hours, and takes the hours out of the day's openings", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/booking");
    const panel = page.locator(".booking-block-time");
    await expect(panel.getByRole("heading", { name: "Block time" })).toBeVisible();

    await panel.getByLabel("Specialist").selectOption({ label: studio.specialistName });
    await panel.getByLabel("Date").fill(isoDate(day));
    await panel.getByLabel("From").fill("11:00");
    await panel.getByLabel("To").fill("13:00");
    await panel.getByRole("button", { name: "Block", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Time blocked.");

    // On the calendar the block stands as taken time, with its own way to undo it,
    // and the master's day is two openings around it.
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    await untilRevealed(page);
    await expect(page.locator(".calendar-entry.status-blocked")).toContainText("11:00–13:00");
    // 08:00–11:00 is three hours and 13:00–20:00 is seven.
    await expect(page.locator(".calendar-free-slot")).toHaveCount(10);
    await expect(page.locator(".calendar-free-slot").nth(2)).toContainText("10:00–11:00");
    await expect(page.locator(".calendar-free-slot").nth(3)).toContainText("13:00–14:00");

    await page.locator(".calendar-entry.status-blocked summary").click();
    await page.getByRole("button", { name: "Unblock" }).click();
    await expect(page.locator(".calendar-free-slot")).toHaveCount(12);

    await context.close();
  });

  test("refuses an end before the start", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/booking");
    const panel = page.locator(".booking-block-time");
    await panel.getByLabel("Date").fill(isoDate(day));
    await panel.getByLabel("From").fill("13:00");
    await panel.getByLabel("To").fill("11:00");
    await panel.getByRole("button", { name: "Block", exact: true }).click();

    await expect(panel.getByRole("alert")).toHaveText("The end has to be after the start.");

    await context.close();
  });
});
