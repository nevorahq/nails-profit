import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "../fixtures";
import { signUp, signedInContext, uniqueSuffix, type Account } from "../helpers/studio";

/**
 * Somebody working alone, registered the way the setup form registers her and
 * left with detailed analytics off, walks every section of the app in all three
 * languages — and meets no word from the finance dictionary on the way.
 *
 * The page's whole text is read with every «Подробнее» opened, so a paragraph
 * folded behind a summary is held to the same words as the line in front of
 * it. What is searched for is the vocabulary the plain view promises not to
 * use (`i18n/lexicon.ts`): commission, imputed, contribution margin.
 */
const FORBIDDEN = {
  ru: /комисси|вменённ|вменен|маржинальн/i,
  ro: /comision|imputat|marj[aă] de contribuție/i,
  en: /commission|imputed|contribution margin/i,
} as const;

type Solo = Readonly<{ owner: Account; serviceId: string; cardId: string }>;

async function registerSolo(baseURL: string, testInfo: TestInfo): Promise<Solo> {
  const suffix = uniqueSuffix(testInfo);
  const owner = await signUp(baseURL, { email: `pw-plain-${suffix}@example.com`, name: "Solo Owner" });
  await owner.post("/api/v1/organizations", {
    name: `PW Plain ${suffix}`.slice(0, 60),
    type: "solo",
    currency: "MDL",
    locale: "ru",
    address: "1 Solo Street",
    timezone: "UTC",
    // What the form sends for somebody working alone:
    // `defaultCommissionBasisPointsFor("solo")`.
    commission_basis_points: 0,
    services: [{ key: "manicure", price_minor: 30_000, duration_minutes: 60 }],
    workweek: { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "08:00", end: "20:00" },
  });
  const services = await owner.get<{ id: string }[]>("/api/v1/services");
  await owner.post("/api/v1/organizations/setup", {
    services: [{ id: services[0].id, price_minor: 30_000, duration_minutes: 60 }],
    workweek: { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "08:00", end: "20:00" },
    open_booking: false,
  });
  const cards = await owner.get<{ id: string }[]>("/api/v1/specialists");

  // A month with something in it: a closed visit and the rent, so the report
  // draws its lines rather than its empty state.
  await owner.post("/api/v1/visits", { specialist_id: cards[0].id, service_id: services[0].id });
  await owner.post("/api/v1/expenses", {
    name: "Аренда",
    category: "rent",
    amount_minor: 500_000,
    spent_on: new Date().toISOString().slice(0, 10),
  });

  return { owner, serviceId: services[0].id, cardId: cards[0].id };
}

async function pageText(page: Page): Promise<string> {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  return page.locator("body").innerText();
}

test.describe("the plain view, for somebody working alone", () => {
  let solo: Solo;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    solo = await registerSolo(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    await solo?.owner.dispose();
  });

  test("says no finance-dictionary word on any screen, in any language", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    test.setTimeout(180_000);
    void browserErrors;

    const sections = [
      "/app",
      "/app/calendar",
      "/app/clients",
      "/app/services",
      `/app/services/${solo.serviceId}`,
      "/app/specialists",
      `/app/specialists/${solo.cardId}`,
      "/app/visits",
      "/app/visits/new",
      "/app/expenses",
      "/app/reports/services",
      "/app/reports/month",
      "/app/booking",
      "/app/import",
      "/app/settings",
      "/app/more",
      "/app/how",
    ];

    const context = await signedInContext(browser, solo.owner, baseURL!);
    const page = await context.newPage();
    const offending: string[] = [];

    for (const locale of ["ru", "ro", "en"] as const) {
      await solo.owner.patch("/api/v1/organizations/settings", { locale });
      for (const path of sections) {
        const response = await page.goto(path);
        expect(response?.status(), `${path} should answer 200`).toBe(200);
        const match = FORBIDDEN[locale].exec(await pageText(page));
        if (match) offending.push(`${locale} ${path}: «${match[0]}»`);
      }
    }

    expect(offending).toEqual([]);

    // The switch is what brings the economist's terms back — and only those:
    // somebody working alone still never reads «commission».
    await solo.owner.patch("/api/v1/organizations/settings", { locale: "en", detailed_analytics: true });
    await page.goto("/app/reports/month");
    const detailed = await pageText(page);
    expect(detailed).toContain("Contribution margin");
    expect(detailed).not.toMatch(/commission/i);

    await context.close();
  });

  test("reads the month in three words, and the switch is the owner's to flip", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    await solo.owner.patch("/api/v1/organizations/settings", { locale: "ru", detailed_analytics: false });
    const context = await signedInContext(browser, solo.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/reports/month");
    const report = page.locator("main");
    await expect(report.getByRole("cell", { name: "Выручка", exact: true })).toBeVisible();
    await expect(report.getByRole("cell", { name: "Осталось", exact: true })).toBeVisible();
    await expect(report.getByText("Осталось за месяц")).toBeVisible();
    await expect(report.getByRole("cell", { name: "Загрузка, %" })).toBeVisible();
    await expect(report.getByText("Экономическая прибыль")).toHaveCount(0);
    await expect(report.getByText(/Практическая мощность/)).toHaveCount(0);

    await page.goto("/app/settings");
    // Folded behind its button on a phone, open on a wide screen.
    const opener = page.getByRole("button", { name: "Настройки", exact: true });
    if (await opener.isVisible()) await opener.click();
    const toggle = page.getByRole("checkbox", { name: "Подробная финансовая аналитика" });
    await expect(toggle).not.toBeChecked();
    // Clear of the phone's bottom bar, which would otherwise take the tap.
    await toggle.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Сохранено")).toBeVisible();

    await page.goto("/app/reports/month");
    await expect(page.getByRole("cell", { name: /^Операционная прибыль до вашего вознаграждения/ })).toBeVisible();

    await context.close();
  });
});
