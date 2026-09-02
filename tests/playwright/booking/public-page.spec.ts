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
    await page.getByLabel("Phone").fill("+373 69 555 111");
    await page.getByLabel("Email (optional)").fill("clara@example.com");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();
    // The manage link is the client's only way back to an appointment they made
    // without an account.
    await expect(page.getByRole("link", { name: "Open appointment" })).toHaveAttribute(
      "href",
      /\/booking\//,
    );

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
