import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * Every screen a signed-in studio can open, opened.
 *
 * A smoke test earns its place by being what fails first: not «the month's
 * profit is wrong» but «the month does not render at all». So each page is
 * asked for three things — it answers 200, it names itself in the topbar, and
 * the browser logged nothing while it did. The third matters most here: these
 * are async Server Components, where a serialization error or a hydration
 * mismatch leaves the markup looking fine and the console full.
 *
 * The studio is seeded once for the file and has a client's request waiting on
 * it, so the pages are exercised with rows in them. An empty table renders in
 * cases a populated one does not.
 */
const OWNER_PAGES = [
  ["/app", "Report"],
  ["/app/calendar", "Calendar"],
  ["/app/clients", "Clients"],
  ["/app/services", "Services"],
  ["/app/specialists", "Specialists"],
  ["/app/visits", "Visits"],
  ["/app/visits/new", "Visits"],
  ["/app/expenses", "Expenses"],
  ["/app/reports/month", "Monthly report"],
  ["/app/booking", "Online booking"],
  ["/app/import", "Import"],
  ["/app/settings", "Settings"],
  ["/app/more", "More"],
] as const;

test.describe("authenticated smoke", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await requestAppointmentAsClient(baseURL!, studio, { date: daysFromToday(1) });
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("every owner screen renders, names itself and logs nothing", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();
    const failures: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console on ${page.url()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => failures.push(`page error on ${page.url()}: ${error.message}`));

    for (const [path, title] of OWNER_PAGES) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should answer 200`).toBe(200);
      await expect(page.locator("h1.topbar-title"), `${path} should name itself`).toHaveText(title);
    }

    // The form behind «закрыть визит» is a page of its own under the section's
    // title, so it states its own purpose as well.
    await page.goto("/app/visits/new");
    await expect(page.getByRole("heading", { name: "Close a visit" })).toBeVisible();

    expect(failures, "screens should not log errors").toEqual([]);
    await context.close();
  });

  test("a master reaches their own screens and is refused the studio's", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();

    for (const [path, title] of [
      ["/app", "Report"],
      ["/app/calendar", "Calendar"],
      ["/app/services", "Services"],
      ["/app/booking", "Online booking"],
      ["/app/settings", "Settings"],
      ["/app/more", "More"],
    ] as const) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should answer 200 for a master`).toBe(200);
      await expect(page.locator("h1.topbar-title")).toHaveText(title);
    }

    // Section 6.1 in the interface: refusals are sentences, not blank screens,
    // and each says whose the section is rather than «forbidden».
    for (const [path, refusal] of [
      ["/app/expenses", "Expenses are the owner's alone."],
      ["/app/reports/month", "The monthly report is the owner's alone."],
      ["/app/import", "Your role may not import data."],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("main")).toContainText(refusal);
    }

    // Settings render for everyone, but only the owner is offered the studio.
    await page.goto("/app/settings");
    await expect(page.locator("main")).toContainText("Delete account");
    await expect(page.locator("main")).not.toContainText("Delete the organization");

    await context.close();
  });

  /**
   * A gap this suite found rather than a test that has ever passed.
   *
   * `/app/visits` and `/app/clients` are hidden from a master's navigation but
   * deliberately still theirs to open — `components/nav-items.ts` says so in as
   * many words, and both pages scope their rows to the person asking. The
   * topbar title, though, is picked from `navFor(role)`, so on those two pages
   * a master gets the organization's name where the page's name belongs: the
   * screen they reach from «закрыть визит» does not say what it is. Building
   * the title list from `navItems` rather than from the filtered navigation
   * would close it; the links stay hidden either way.
   */
  test.fixme("a master's own visits and clients name themselves", async ({ browser }) => {
    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();

    for (const [path, title] of [
      ["/app/visits", "Visits"],
      ["/app/clients", "Clients"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("h1.topbar-title")).toHaveText(title);
    }

    await context.close();
  });

  test("the signed-out perimeter holds on every private route", async ({ page, browserErrors }) => {
    void browserErrors;
    for (const [path] of OWNER_PAGES) {
      await page.goto(path);
      await expect(page, `${path} should send an anonymous visitor to sign in`).toHaveURL(/\/login/);
    }
  });

  test("the API refuses anonymous reads of a studio's data", async ({ request }) => {
    for (const path of [
      "/api/v1/bookings",
      "/api/v1/clients",
      "/api/v1/services",
      "/api/v1/visits",
      "/api/v1/expenses",
      "/api/v1/specialists",
    ]) {
      const response = await request.get(path);
      expect(response.status(), `${path} should refuse an anonymous caller`).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    }
  });
});
