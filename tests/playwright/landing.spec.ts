import { expect, test } from "./fixtures";

test.describe("landing experience", () => {
  test("calculator updates its result and business mode", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto("/");

    const calculator = page.locator(".calculator-card");
    const sliders = calculator.getByRole("slider");
    await expect(sliders).toHaveCount(3);
    await sliders.nth(0).fill("900");
    await sliders.nth(1).fill("50");
    await sliders.nth(2).fill("250");
    await expect(calculator.getByText("600 MDL", { exact: true })).toBeVisible();
    await expect(calculator.getByText("400 MDL", { exact: true })).toBeVisible();

    const visit = page.getByLabel("Visit example");
    // The whole demo card deliberately floats forever, so Playwright can never
    // observe this descendant as geometrically stable. Dispatch the real click
    // event directly; React's handler and state update still run.
    await page.getByRole("button", { name: "Solo specialist" }).dispatchEvent("click");
    await expect(visit.getByText("Specialist commission")).toHaveCount(0);
    await expect(visit.getByText("558 MDL", { exact: true })).toBeVisible();
  });

  test("primary navigation opens sign-up without a full reload failure", async ({
    page,
    browserErrors,
  }) => {
    void browserErrors;
    await page.goto("/");

    await page.getByRole("link", { name: "Start costing" }).first().click();
    await expect(page).toHaveURL(/\/login\?mode=signup$/);
    await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
    await expect(page.getByLabel("Your name")).toBeVisible();
  });

  test("pricing switches every card between prepay periods", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto("/");

    const cards = page.locator(".pricing-card");
    await expect(cards).toHaveCount(3);
    // The middle plan is the featured one and stays that way across periods.
    await expect(cards.nth(1)).toHaveClass(/featured/);

    // Default is month-to-month: the sticker price is the monthly amount.
    await expect(cards.nth(0).locator(".pricing-price strong")).toHaveText("€17");
    await expect(cards.nth(1).locator(".pricing-price strong")).toHaveText("€29");
    await expect(cards.nth(2).locator(".pricing-price strong")).toHaveText("€59");
    await expect(cards.nth(1).locator(".pricing-terms")).toHaveText("Billed every month");
    await expect(page.locator(".pricing-save")).toHaveCount(0);

    // Six-month prepay drops the headline to the effective monthly rate and
    // names the amount actually charged.
    await page.getByRole("button", { name: "6 months" }).click();
    await expect(cards.nth(0).locator(".pricing-price strong")).toHaveText("€14.83");
    await expect(cards.nth(1).locator(".pricing-price strong")).toHaveText("€24.83");
    await expect(cards.nth(1).locator(".pricing-terms")).toContainText("€149 for 6 months");
    await expect(cards.nth(1).locator(".pricing-save")).toContainText("14%");

    await expect(
      cards.nth(1).getByRole("link", { name: /Start free trial/ }),
    ).toHaveAttribute("href", "/login?mode=signup");
  });
});
