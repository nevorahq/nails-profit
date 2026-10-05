import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * «Прибыль показана до налогов и комиссии банка — указать», until the owner
 * has said how the studio pays taxes and how its clients pay.
 *
 * A fresh studio has answered neither, so its report and its first card say
 * so; the link leads to the two questions on «Деньги», and once both are
 * answered — «не плачу с визита» and «только наличные» are answers — the line
 * is gone from both. The plain view's wording, since a new studio starts with
 * detailed analytics off.
 */
const WARNING = "Profit is shown before taxes and the bank's card fee";

/**
 * Tick a box from the middle of the screen: scrolled to the top edge it sits
 * under the sticky topbar, which takes the click.
 */
async function check(box: Locator) {
  await box.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await box.check();
}

/** The guide's «Шаг выполнен» window, when the answer finished a step. */
async function closeGuideWindow(page: Page) {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test.describe("the report before taxes and the bank's fee", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await studio.owner.post("/api/v1/visits", {
      specialist_id: studio.specialistId,
      service_id: studio.serviceId,
    });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("is said until both questions are answered, and not after", async ({ baseURL, browser, browserErrors }, testInfo) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.locator(".headline-card")).toContainText(WARNING);

    await page.goto("/app/reports/month");
    const banner = page.locator(".pl-before-taxes");
    await expect(banner).toContainText(WARNING);
    await page.screenshot({ path: testInfo.outputPath("report-before-taxes.png"), fullPage: true });

    await banner.getByRole("link", { name: "set them" }).click();
    await page.waitForURL("**/app/expenses#taxes");
    const taxes = page.getByRole("heading", { name: "How do you pay taxes?" });
    await expect(taxes).toBeVisible();
    const question = page.locator("#taxes");
    // No rate is offered before one is chosen, and none is typed in for the owner.
    await expect(question.getByLabel("Rate, %")).toHaveCount(0);
    await check(question.getByLabel("Turnover tax"));
    await expect(question.getByLabel("Rate, %")).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath("money-questions.png"), fullPage: true });

    await check(question.getByLabel("I pay none per visit"));
    await question.getByRole("button", { name: "Answer" }).click();
    await expect(taxes).toHaveCount(0);
    await closeGuideWindow(page);

    // Half an answer is not an answer: the bank's fee is still unknown.
    await page.goto("/app/reports/month");
    await expect(page.locator(".pl-before-taxes")).toContainText(WARNING);
    await page.locator(".pl-before-taxes").getByRole("link", { name: "set them" }).click();
    await page.waitForURL("**/app/expenses#payments");

    const payments = page.getByRole("heading", { name: "How do clients pay?" });
    await expect(payments).toBeVisible();
    await check(page.locator("#payments").getByLabel("Cash", { exact: true }));
    await page.locator("#payments").getByRole("button", { name: "Answer" }).click();
    await expect(payments).toHaveCount(0);
    await closeGuideWindow(page);

    await page.goto("/app/reports/month");
    await expect(page.locator(".pl-before-taxes")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(WARNING);
    await page.goto("/app");
    await expect(page.locator(".headline-card")).not.toContainText(WARNING);

    // The answers are the rules «Деньги» keeps from now on.
    const methods = await studio.owner.get<{ kind: string; is_default: boolean }[]>("/api/v1/payment-methods");
    expect(methods).toEqual([expect.objectContaining({ kind: "cash", is_default: true })]);
    await context.close();
  });

  test("is not drawn for a master, whose card is their own earnings", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.master, baseURL!);
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.getByTestId("headline-value")).toBeVisible();
    await expect(page.locator("main")).not.toContainText(WARNING);
    await context.close();
  });
});

test.describe("«Зарплата» on the expense form", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("records money for oneself as a draw, and writes no expense", async ({ baseURL, browser, browserErrors }, testInfo) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/expenses");
    await page.getByRole("link", { name: "Add an expense" }).filter({ visible: true }).first().click();
    // The period filter above has a «Category» of its own, folded away.
    const form = page.locator("#add-expense");
    await form.getByLabel("Expense name").fill("For me");
    await form.getByLabel("Category").selectOption("payroll");
    await expect(form.getByText("What is this payment?")).toBeVisible();

    // A salary is not a row here: the form gives way to where it is set.
    await check(form.getByLabel(/^A salary/));
    await expect(form.getByLabel("Purchase amount")).toHaveCount(0);
    await expect(form.getByRole("link", { name: "Open Settings" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("payroll-question.png"), fullPage: true });

    await check(form.getByLabel(/^Money for myself/));
    await form.getByLabel("Purchase amount").fill("150");
    await form.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page.locator("main")).toContainText("For me");
    const draws = await studio.owner.get<{ amount_minor: number; note: string | null }[]>("/api/v1/owner-draws");
    expect(draws).toEqual([expect.objectContaining({ amount_minor: 15_000, note: "For me" })]);
    const expenses = await studio.owner.get<unknown[]>("/api/v1/expenses");
    expect(expenses).toEqual([]);
    await context.close();
  });
});
