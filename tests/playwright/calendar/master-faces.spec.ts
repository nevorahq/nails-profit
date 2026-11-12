import { expect, test } from "../fixtures";
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
 * Whose calendar this is, as faces on the bar: the studio first — «all
 * masters» — and then each master. The chosen one is marked, named under the
 * row, and pressing it again takes the filter off.
 */
test.describe("the master faces on the calendar bar", () => {
  let studio: Studio;
  const day = daysFromToday(1);

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await requestAppointmentAsClient(baseURL!, studio, { date: day, name: "Own Client" });
    await requestAppointmentAsClient(baseURL!, studio, {
      date: day,
      specialistId: studio.colleagueId,
      name: "Colleague Client",
    });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  const open = async (browser: Parameters<typeof signedInContext>[0], baseURL: string, query = "") => {
    const context = await signedInContext(browser, studio.owner, baseURL);
    const page = await context.newPage();
    await page.goto(`/app/calendar?date=${isoDate(day)}${query}`);
    // The tests measure boxes, and a box is null while the page is still
    // behind its skeleton.
    await untilRevealed(page);
    return { context, page, faces: page.locator(".calendar-masters-row") };
  };

  test("the studio is first, then every master, and nobody is marked until chosen", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page, faces } = await open(browser, baseURL!);

    const links = faces.getByRole("link");
    await expect(links).toHaveCount(3);
    await expect(links.nth(0)).toHaveAccessibleName("All specialists");
    // The roster is in name order: Cora before Mara.
    await expect(links.nth(1)).toHaveAccessibleName(studio.colleagueName);
    await expect(links.nth(2)).toHaveAccessibleName(studio.specialistName);

    // «All» is what is showing, and it says so, in words as well as in the ring.
    await expect(links.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".calendar-masters-caption")).toHaveText("All specialists");
    // No logo uploaded: the studio's initial stands in for it.
    await expect(links.nth(0).locator(".avatar")).toHaveText("P");
    await expect(page.locator(".calendar-entry")).toHaveCount(2);

    // Big enough to press without aiming: the face is 80, its box 88.
    const box = (await links.nth(1).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(86);
    expect(box.height).toBeGreaterThanOrEqual(86);
    const face = (await links.nth(1).locator(".avatar").boundingBox())!;
    expect(face.width).toBeGreaterThanOrEqual(78);
    await context.close();
  });

  test("the month and «Today» are the first row, the faces the second under them", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page, faces } = await open(browser, baseURL!);

    const month = (await page.locator(".calendar-period select").boundingBox())!;
    const today = (await page.getByRole("link", { name: "Today" }).boundingBox())!;
    const row = (await faces.boundingBox())!;

    // The month, then «Today», on one line; the faces below both, with air between.
    expect(month.x).toBeLessThan(today.x);
    expect(Math.abs(month.y + month.height / 2 - (today.y + today.height / 2))).toBeLessThan(6);
    expect(row.y).toBeGreaterThanOrEqual(Math.max(month.y + month.height, today.y + today.height) + 12);
    await context.close();
  });

  test("pressing a master narrows the day to them, and the address keeps it", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page, faces } = await open(browser, baseURL!);

    await faces.getByRole("link", { name: studio.specialistName }).click();

    await expect(page).toHaveURL(new RegExp(`specialist=${studio.specialistId}`));
    await expect(page.locator(".calendar-entry")).toHaveCount(1);
    await expect(page.locator(".calendar-entry")).toContainText("Own Client");
    await expect(faces.getByRole("link", { name: studio.specialistName })).toHaveAttribute("aria-current", "true");
    await expect(faces.getByRole("link", { name: "All specialists" })).not.toHaveAttribute("aria-current", "true");
    await expect(page.locator(".calendar-masters-caption")).toHaveText(studio.specialistName);

    // The same link, opened fresh, is the same filter.
    await page.reload();
    await expect(page.locator(".calendar-entry")).toHaveCount(1);
    await context.close();
  });

  test("pressing the chosen master again, or the studio, takes the filter off", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page, faces } = await open(browser, baseURL!, `&specialist=${studio.colleagueId}`);
    await expect(page.locator(".calendar-entry")).toHaveCount(1);

    await faces.getByRole("link", { name: studio.colleagueName }).click();
    await expect(page.locator(".calendar-entry")).toHaveCount(2);
    expect(new URL(page.url()).searchParams.get("specialist")).toBeNull();

    await faces.getByRole("link", { name: studio.specialistName }).click();
    await expect(page.locator(".calendar-entry")).toHaveCount(1);
    await faces.getByRole("link", { name: "All specialists" }).click();
    await expect(page.locator(".calendar-entry")).toHaveCount(2);
    expect(new URL(page.url()).searchParams.get("specialist")).toBeNull();
    await context.close();
  });

  test("keeps the day and the other controls while it changes the master", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const { context, page, faces } = await open(browser, baseURL!);

    await faces.getByRole("link", { name: studio.colleagueName }).click();
    await expect(page).toHaveURL(new RegExp(`date=${isoDate(day)}`));
    await expect(page.locator(".calendar-period select")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Today" })).toBeVisible();
    // The year is no longer a control of its own.
    await expect(page.getByRole("combobox", { name: "Year" })).toHaveCount(0);
    await context.close();
  });

  test("does not push the page sideways", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const { context, page } = await open(browser, baseURL!);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });
});
