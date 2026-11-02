import { expect, test } from "../fixtures";
import { chooseService, chooseSpecialist, openBookingForm, typeNewClient } from "../helpers/booking-form";
import {
  daysFromToday,
  disposeStudio,
  isoDate,
  requestAppointmentAsClient,
  seedStudio,
  signedInContext,
  type Studio,
} from "../helpers/studio";

/**
 * «Записать клиента» is a window opened by the round «+», not a block on the
 * page, and the time in it is chosen from the day's free times.
 *
 * The fixture rota is 08:00–20:00 in UTC on an hourly grid, the service runs
 * ninety minutes, and an appointment already stands at 09:00 on the day under
 * test: it takes 09:00–10:30 and the ten-minute turnaround after it, so the
 * starts at 08:00, 09:00 and 10:00 are not free and 11:00 is.
 */
test.describe("the appointment window", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    await requestAppointmentAsClient(baseURL!, studio, { date: day, afterTime: "09:00", name: "Booked First" });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  /** With one master's calendar open, as the desk usually has it; `everyone` shows the whole studio's. */
  async function openCalendar(
    browser: Parameters<typeof signedInContext>[0],
    baseURL: string,
    { everyone = false }: { everyone?: boolean } = {},
  ) {
    const context = await signedInContext(browser, studio.owner, baseURL);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}${everyone ? "" : `&specialist=${studio.specialistId}`}`);
    return { context, page };
  }

  test("is not on the page until the round button opens it", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);

    // Neither the toolbar's labelled button nor a form standing open.
    await expect(page.getByRole("link", { name: "New appointment" })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("New client's name")).toHaveCount(0);

    const dialog = await openBookingForm(page);
    // On the day the calendar was showing, not today.
    await expect(dialog.getByLabel("Date")).toHaveValue(isoDate(day));
    // Opening it is not a navigation: the day and the master behind the window stay.
    expect(page.url()).toContain(`date=${isoDate(day)}`);
    expect(page.url()).toContain(`specialist=${studio.specialistId}`);
    await context.close();
  });

  test("is as tall as its form, and only the page scrolls", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    const block = page.locator(".calendar-compose-scroll");
    const book = dialog.getByRole("button", { name: "Book", exact: true });

    // Once the free times have arrived: they change the form's height, so every
    // measurement below is of the form as it will stay.
    await expect(dialog.getByRole("status")).toHaveCount(0);

    // Nothing in the window scrolls: the card and the block round it show their
    // whole form, and neither is a scroll box.
    for (const element of [dialog, block]) {
      const inner = await element.evaluate((node) => ({
        overflow: getComputedStyle(node).overflowY,
        scrolls: node.scrollHeight > node.clientHeight + 1,
      }));
      expect(inner.overflow).toBe("visible");
      expect(inner.scrolls).toBe(false);
    }
    // The page ends where the form does: the calendar is out of the flow while it
    // is open, so nothing but the bottom bar's room follows the card.
    await expect(page.locator(".calendar-toolbar")).toBeHidden();
    const below = await page.evaluate(() => {
      const card = document.querySelector(".calendar-compose-dialog")!.getBoundingClientRect();
      return document.documentElement.scrollHeight - (card.bottom + window.scrollY);
    });
    expect(below).toBeLessThanOrEqual(130);

    // The block is exactly as tall as the card and its room — not a screen.
    const card = (await dialog.boundingBox())!;
    const room = (await block.boundingBox())!;
    expect(room.height).toBeGreaterThanOrEqual(card.height);
    expect(room.height).toBeLessThanOrEqual(card.height + 40);

    // The page is not held: it is the page that moves.
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");

    // At the top the form starts under the top bar, not behind it.
    const viewport = page.viewportSize()!;
    const topBar = (await page.locator(".app-topbar").boundingBox())!;
    expect(card.y).toBeGreaterThanOrEqual(topBar.y + topBar.height);

    // The end of the form is reachable by scrolling the page, and nothing draws
    // over it there: the last button is whole on screen, and the thing at its
    // centre is the button, not a bar. Instant: the page's own
    // `scroll-behavior: smooth` would still be moving when the position is read.
    await book.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" }));
    await expect(book).toBeInViewport({ ratio: 1 });
    const covered = await book.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top !== node && !node.contains(top);
    });
    expect(covered).toBe(false);

    // And lower still, the bottom bar is above the dimmed page, not the form: the
    // form's own end is never closer to it than the form's last button.
    const last = (await book.boundingBox())!;
    const bottomBar = await page.locator(".bottom-nav").boundingBox();
    const floor = bottomBar && bottomBar.height > 0 ? bottomBar.y : viewport.height;
    expect(last.y + last.height).toBeLessThanOrEqual(floor);

    // Back at the top, the page behind is dimmed and cannot be pressed.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(page.locator(".calendar-compose-dim")).toBeAttached();

    // The page scrolls the same once the window is closed.
    await page.keyboard.press("Escape");
    await expect(page.locator(".calendar-compose-dim")).toHaveCount(0);
    await context.close();
  });

  test("offers the free times of the chosen day, and not the taken ones", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!, { everyone: true });
    const dialog = await openBookingForm(page);
    await chooseSpecialist(dialog, studio.specialistName);
    await chooseService(dialog, "Manicure with coating");

    const chip = (time: string) => dialog.getByRole("button", { name: time, exact: true });
    await expect(chip("11:00")).toBeVisible();
    for (const taken of ["08:00", "09:00", "10:00"]) await expect(chip(taken)).toHaveCount(0);

    // Another master has nobody booked: their 09:00 is free.
    await dialog.getByRole("button", { name: "Change" }).click();
    await chooseSpecialist(dialog, studio.colleagueName);
    await expect(chip("09:00")).toBeVisible();

    await context.close();
  });

  test("asks again when the date changes", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await chooseService(dialog, "Manicure with coating");
    await expect(dialog.getByRole("button", { name: "11:00", exact: true })).toBeVisible();

    const other = isoDate(daysFromToday(3));
    const asked = page.waitForRequest(
      (request) => request.url().includes("/api/v1/availability/slots") && request.url().includes(`date=${other}`),
    );
    await dialog.getByLabel("Date").fill(other);
    await asked;

    // Nothing stands on that day: the hour the first one took is free again.
    await expect(dialog.getByRole("button", { name: "09:00", exact: true })).toBeVisible();
    await context.close();
  });

  test("books the tapped time, closes, and puts the appointment in the day", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await chooseService(dialog, "Manicure with coating");

    await dialog.getByRole("button", { name: "12:00", exact: true }).click();
    await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue("12:00");
    await expect(dialog.getByRole("button", { name: "12:00", exact: true })).toHaveAttribute("aria-pressed", "true");

    await typeNewClient(dialog, "Tapped Slot");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    const entry = page.locator(".calendar-entry").filter({ hasText: "Tapped Slot" });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("12:00");
    await context.close();
  });

  test("still takes a time typed by hand", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await chooseService(dialog, "Manicure with coating");

    // No row of its own: the way to a time off the grid is «Other», the grid's last chip.
    await expect(dialog.getByText("Time", { exact: true })).toHaveCount(0);
    await expect(dialog.locator(".slot-picker-list > .time-more:last-child button")).toHaveText("Other");
    await dialog.getByLabel("Time", { exact: true }).fill("14:20");
    // A time off the grid stands among the others, lit.
    await expect(dialog.getByRole("button", { name: "14:20", exact: true })).toHaveAttribute("aria-pressed", "true");
    await typeNewClient(dialog, "Typed Time");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".calendar-entry").filter({ hasText: "Typed Time" })).toContainText("14:20");
    await context.close();
  });

  test("shows a refusal inside the window and keeps what was typed", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await chooseService(dialog, "Manicure with coating");

    // 09:00 is the hour the fixture's appointment holds.
    await dialog.getByLabel("Time", { exact: true }).fill("09:00");
    await typeNewClient(dialog, "Double Booked");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("New client's name")).toHaveValue("Double Booked");
    await context.close();
  });

  test("closes on Escape and on «Cancel», but not on a tap outside it", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);

    let dialog = await openBookingForm(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    dialog = await openBookingForm(page);
    // A tap on the dimmed page beside the form: nothing happens.
    await page.mouse.click(3, 300);
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await context.close();
  });

  test("has a cross in its top right corner that closes it", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);

    const cross = dialog.getByRole("button", { name: "Close the window" });
    await expect(cross).toBeVisible();
    // An icon, not a labelled button: the name is for the screen reader.
    await expect(cross).toHaveText("");

    // In the card's top right corner, and big enough to press.
    const card = (await dialog.boundingBox())!;
    const box = (await cross.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(43);
    expect(box.height).toBeGreaterThanOrEqual(43);
    expect(card.x + card.width - (box.x + box.width)).toBeLessThanOrEqual(16);
    expect(box.y - card.y).toBeLessThanOrEqual(16);

    await cross.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // And the page is whole again behind it.
    await expect(page.locator(".calendar-toolbar")).toBeVisible();
    await context.close();
  });

  test("takes the only service of a studio that sells one, so there is nothing to choose", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);

    await expect(dialog.getByRole("checkbox", { name: /^Manicure with coating/ })).toBeChecked();
    await expect(dialog.getByText("Choose a service to see the free times.")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "11:00", exact: true })).toBeVisible();
    await context.close();
  });

  test("has no «Other» on a day with no free times", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await chooseService(dialog, "Manicure with coating");
    await expect(dialog.locator(".time-more")).toHaveCount(1);

    // A day before the rota begins has no times, whatever the reason the picker gives.
    await dialog.getByLabel("Another date").fill("2020-01-01");
    await expect(dialog.locator(".slot-picker p:not([role=status])")).toBeVisible();
    await expect(dialog.locator(".time-more")).toHaveCount(0);
    await expect(dialog.locator(".slot-chip")).toHaveCount(0);

    // And back on a day that has them, it comes back.
    await dialog.getByLabel("Another date").fill(isoDate(day));
    await expect(dialog.locator(".time-more")).toHaveCount(1);
    await context.close();
  });

  test("is the open master's own, with no question about whom to book", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await chooseService(dialog, "Manicure with coating");

    // No row of faces to choose from: it would only ask what the calendar has said.
    await expect(dialog.locator(".master-picker")).toHaveCount(0);
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expect(dialog.locator(".calendar-compose-master")).toContainText(studio.specialistName);

    // Their face stands in the middle of the form, and is not something to press.
    const avatar = dialog.locator(".calendar-compose-master .avatar");
    const card = (await dialog.boundingBox())!;
    const face = (await avatar.boundingBox())!;
    expect(face.x + face.width / 2).toBeCloseTo(card.x + card.width / 2, 0);
    await expect(dialog.locator(".calendar-compose-master button .avatar, .calendar-compose-master a .avatar")).toHaveCount(0);
    // The one thing to press beside it is the way back to the question.
    await expect(dialog.locator(".calendar-compose-master").getByRole("button")).toHaveCount(1);

    // And the booking is theirs: the calendar behind shows only this master.
    await dialog.getByRole("button", { name: "15:00", exact: true }).click();
    await typeNewClient(dialog, "Bound To Open Master");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".calendar-entry").filter({ hasText: "Bound To Open Master" })).toContainText("15:00");
    await context.close();
  });

  test("asks whom to book first when the calendar shows everybody, and shows nothing else until then", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!, { everyone: true });
    const dialog = await openBookingForm(page);

    // The question, with nobody chosen for the desk, and nothing under it.
    await expect(dialog.getByRole("radio")).toHaveCount(2);
    await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(dialog.locator(".master-picker-item", { hasText: studio.colleagueName })).toBeVisible();
    await expect(dialog.locator(".calendar-compose-master")).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: /^Service/ })).toHaveCount(0);
    await expect(dialog.locator(".day-strip")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Book", exact: true })).toHaveCount(0);

    // Choosing one opens the form on them, with a way back to the question.
    await chooseSpecialist(dialog, studio.colleagueName);
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expect(dialog.locator(".calendar-compose-master")).toContainText(studio.colleagueName);
    await expect(dialog.getByRole("button", { name: "Book", exact: true })).toBeVisible();

    // Sent back, what was typed stays and nobody is chosen again.
    await dialog.getByRole("button", { name: "Change" }).click();
    await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
    await context.close();
  });

  test("opens its own month in the middle of the screen from «More», and a day picked there is the date", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);

    await dialog.locator(".day-strip .day-more button").click();
    const picker = page.getByRole("dialog", { name: "Choose a date" });
    await expect(picker).toBeVisible();

    // In the middle, whatever the screen.
    const box = (await picker.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x + box.width / 2).toBeCloseTo(view.width / 2, 0);
    expect(Math.abs(box.y + box.height / 2 - view.height / 2)).toBeLessThan(view.height * 0.15);
    // And over the bottom bar and the round button, which stand at 90 and 95.
    const top = await picker.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height - 8)?.closest(".date-picker") !== null;
    });
    expect(top).toBe(true);

    // The month opens on the form's date, lit.
    await expect(picker.locator(`button[data-date="${isoDate(day)}"]`)).toHaveAttribute("aria-pressed", "true");

    // Escape shuts this window and leaves the appointment window under it.
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // A day in the next month, picked there, is the date, and the window closes.
    await dialog.locator(".day-strip .day-more button").click();
    await picker.getByRole("button", { name: "Next month" }).click();
    const next = isoDate(daysFromToday(40)).slice(0, 7);
    const wanted = new Date(Date.UTC(Number(isoDate(day).slice(0, 4)), Number(isoDate(day).slice(5, 7)), 15)).toISOString().slice(0, 10);
    await picker.locator(`button[data-date="${wanted}"]`).click();
    await expect(picker).toHaveCount(0);
    await expect(dialog.getByLabel("Another date")).toHaveValue(wanted);
    void next;
    await context.close();
  });

  test("offers the next two weeks as days, and a tapped day is the date", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);

    const strip = dialog.locator(".day-strip button[data-date]");
    await expect(strip).toHaveCount(14);

    // «More» ends the strip and is always in reach: on a phone the days scroll
    // under it, so the one tile that opens every other day is not at the far end.
    const more = dialog.locator(".day-strip .day-more button");
    await expect(more).toHaveText("More");
    const tile = (await more.boundingBox())!;
    expect(tile.x + tile.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(dialog.getByLabel("Another date")).toHaveCount(1);

    // And the day the form opened on is in plain sight beside it, not under it.
    const lit = (await dialog.locator(".day-strip button[aria-pressed=\"true\"]").boundingBox())!;
    expect(lit.x).toBeGreaterThanOrEqual(0);
    expect(lit.x + lit.width).toBeLessThanOrEqual(tile.x + 1);
    // The day the calendar was showing is beyond the first two weeks' start only
    // by chance; whichever it is, the date field's day is the lit one.
    await expect(dialog.locator(`.day-strip button[data-date="${isoDate(day)}"]`)).toHaveAttribute("aria-pressed", "true");

    const target = isoDate(daysFromToday(5));
    await dialog.locator(`.day-strip button[data-date="${target}"]`).click();
    await expect(dialog.getByLabel("Another date")).toHaveValue(target);
    await expect(dialog.locator(`.day-strip button[data-date="${target}"]`)).toHaveAttribute("aria-pressed", "true");

    // And the other way: a date typed far out is on the strip and lit.
    const far = isoDate(daysFromToday(40));
    await dialog.getByLabel("Another date").fill(far);
    await expect(dialog.locator(`.day-strip button[data-date="${far}"]`)).toHaveAttribute("aria-pressed", "true");
    await context.close();
  });

  test("finds an existing client by the digits of their number and books them", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    await studio.owner.post("/api/v1/clients", { name: "Findable Fiona", phone: "+373 69 111 222" });
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);
    await chooseService(dialog, "Manicure with coating");

    const search = dialog.getByRole("combobox", { name: "Client" });
    // Spaces in what is typed, none in what is stored: the digits are compared.
    await search.fill("69 111");
    const found = dialog.getByRole("option", { name: /Findable Fiona/ });
    await expect(found).toBeVisible();
    // A number that is not in the base offers only «New client», never a name.
    await search.fill("69 999");
    await expect(dialog.getByRole("option", { name: /Findable Fiona/ })).toHaveCount(0);
    await expect(dialog.getByRole("option", { name: /New client: 69 999/ })).toBeVisible();

    await search.fill("fiona");
    await dialog.getByRole("option", { name: /Findable Fiona/ }).click();
    // The card replaces the search, and no fields for a new client are open.
    await expect(dialog.locator(".client-picker-card")).toContainText("Findable Fiona");
    await expect(dialog.getByLabel("New client's name")).toHaveCount(0);

    await dialog.getByRole("button", { name: "13:00", exact: true }).click();
    await dialog.getByRole("button", { name: "Book", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".calendar-entry").filter({ hasText: "Findable Fiona" })).toContainText("13:00");
    await context.close();
  });

  test("turns a typed number into a new client with that number, and Enter does not send the form", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page } = await openCalendar(browser, baseURL!);
    const dialog = await openBookingForm(page);

    const search = dialog.getByRole("combobox", { name: "Client" });
    await search.fill("+373 68 000 111");
    await search.press("Enter");

    // Still the window, now with the number where it belongs and the name empty.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Phone")).toHaveValue("+373 68 000 111");
    await expect(dialog.getByLabel("New client's name")).toHaveValue("");
    await expect(dialog.getByLabel("New client's name")).toHaveAttribute("required", "");

    // «Change» takes the fields away and brings the search back.
    await dialog.locator(".client-picker").getByRole("button", { name: "Change" }).click();
    await expect(dialog.getByLabel("New client's name")).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: "Client" })).toHaveValue("");
    await context.close();
  });

  test("opens from the shell's link on arrival, and does not reopen on reload", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}#new-booking`);

    await expect(page.getByRole("dialog", { name: "New appointment" })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");

    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await context.close();
  });
});

/**
 * What the form offers is what the chosen master does, at their prices.
 *
 * Mara has no list of her own, so she does everything the studio sells; Cora
 * does one thing, a second service, and charges her own price for it. The
 * server refuses a service outside a non-empty list, so a form that offered
 * the whole catalogue found out only at «Book».
 */
test.describe("the appointment window's services follow the master", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    const gel = await studio.owner.post<{ id: string }>("/api/v1/services", {
      name: { en: "Gel removal" },
      price_minor: 15000,
      duration_minutes: 30,
    });
    await studio.owner.put(`/api/v1/specialists/${studio.colleagueId}/services`, {
      services: [{ service_id: gel.id, price_minor: 20000 }],
    });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("does not choose a service for the desk, and says so instead of showing no times", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    const dialog = await openBookingForm(page);

    // Nothing is ticked, and where the free times would be there is a reason, not a gap.
    await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(dialog.getByText("Choose a service to see the free times.")).toBeVisible();
    await expect(dialog.locator(".slot-picker")).toHaveCount(0);

    // A booking with no service is refused in the window, with what was typed kept.
    await typeNewClient(dialog, "No Service Chosen");
    await dialog.getByRole("button", { name: "Book", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Choose at least one service.");
    await expect(dialog.getByLabel("New client's name")).toHaveValue("No Service Chosen");

    // «Other» belongs to the grid of free times: with no grid, it is not there either.
    await expect(dialog.locator(".time-more")).toHaveCount(0);

    // Ticked, the times appear for it, and «Other» after the last of them.
    await chooseService(dialog, "Manicure with coating");
    await expect(dialog.locator(".slot-picker-list > .time-more:last-child")).toHaveCount(1);
    await expect(dialog.getByText("Choose a service to see the free times.")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "11:00", exact: true })).toBeVisible();
    await context.close();
  });

  test("lists only the chosen master's services, at their own price, and follows a change of master", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}`);
    const dialog = await openBookingForm(page);
    const rows = dialog.locator(".service-row");

    // Mara does everything the studio sells, at the studio's price, and nothing is ticked for the desk.
    await chooseSpecialist(dialog, studio.specialistName);
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Gel removal" })).toContainText("150");
    await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(dialog.locator(".service-rows-total")).toHaveCount(0);

    // Ticked, a service counts: its price and length are the sitting's.
    await chooseService(dialog, "Manicure with coating");
    await expect(dialog.locator(".service-rows-total")).toContainText("600");

    // Cora does one thing, the price shown is hers, and the manicure Mara had does not come along.
    await dialog.getByRole("button", { name: "Change" }).first().click();
    await chooseSpecialist(dialog, studio.colleagueName);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Gel removal");
    await expect(rows.first()).toContainText("200");
    await expect(dialog.getByRole("checkbox", { name: /Manicure/ })).toHaveCount(0);
    // Her only service is the one, and so it is the appointment, without a tick.
    await expect(dialog.getByRole("checkbox", { name: /Gel removal/ })).toBeChecked();
    await context.close();
  });
});

/**
 * A long price list does not push the rest of the form off the screen: past six
 * services only the ticked ones show, and a button opens the rest.
 */
test.describe("the appointment window's long price list", () => {
  let studio: Studio;
  const day = daysFromToday(2);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
    for (const name of ["Pedicure", "Gel removal", "Brow shaping", "Lash lift", "Paraffin hands", "Foot massage"]) {
      await studio.owner.post("/api/v1/services", { name: { en: name }, price_minor: 10000, duration_minutes: 30 });
    }
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("shows the ticked ones and opens the rest on request", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}&specialist=${studio.specialistId}`);
    const dialog = await openBookingForm(page);
    const rows = dialog.locator(".service-row");

    // Seven services, nothing ticked: none of them takes room until asked.
    await expect(rows).toHaveCount(0);
    await dialog.getByRole("button", { name: "All services (7)" }).click();
    await expect(rows).toHaveCount(7);

    await chooseService(dialog, "Pedicure");
    await dialog.getByRole("button", { name: "Show fewer" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Pedicure");
    await context.close();
  });
});
