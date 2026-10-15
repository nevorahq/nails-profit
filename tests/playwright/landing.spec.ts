import { expect, test } from "./fixtures";

test.describe("landing experience", () => {
  test("calculator updates its result and business mode", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto("/");

    const calculator = page.locator(".calculator-card");
    const sliders = calculator.getByRole("slider");
    await expect(sliders).toHaveCount(3);
    // The page is server-rendered, so the sliders are on screen a beat before
    // React listens to them: a value set in that beat is lost. Retried until
    // the reading follows — and through another value each time, because the
    // lost one can stay in the slider, and setting a slider to the value it
    // already shows is no change React would hear about.
    await expect(async () => {
      await sliders.nth(0).fill("890");
      await sliders.nth(0).fill("900");
      await expect(calculator.getByRole("status").first()).toContainText("900", { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
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

  test("fits a 375 px phone without scrolling sideways", async ({ page, browserErrors }) => {
    void browserErrors;
    // Narrower than either project's device: the smallest phone the pilot's
    // owners carry, and the width at which a fixed-size block first spills.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");

    await expect(page.getByText("Bookings and profit in one place")).toBeVisible();
    // Scrolled to the bottom so every revealed section has laid out; a block
    // that spills only after its entrance animation would otherwise pass.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow).toEqual({ document: 0, body: 0 });

    // `.marketing-page` clips with `overflow: hidden`, so a spilling block
    // shows no scrollbar — it is cut off instead. Every element that carries
    // text of its own has to sit inside the screen.
    const cutOff = await page.evaluate(() =>
      [...document.querySelectorAll("main *")]
        .filter((element) =>
          [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()),
        )
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
        })
        .map((element) => element.textContent?.trim().slice(0, 40)),
    );
    expect(cutOff).toEqual([]);
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
    await expect(page.getByLabel("Studio name")).toBeVisible();
  });

  test("pricing switches every card between prepay periods", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto("/");

    const cards = page.locator(".pricing-card");
    await expect(cards).toHaveCount(4);
    // Studio is the featured plan and stays that way across periods.
    await expect(cards.nth(2)).toHaveClass(/featured/);

    // Default is month-to-month: the sticker price is the monthly amount, and
    // Start is free whatever the period.
    await expect(cards.nth(0).locator(".pricing-price strong")).toHaveText("€0");
    await expect(cards.nth(0).locator(".pricing-terms")).toHaveText("Free, no time limit");
    await expect(cards.nth(1).locator(".pricing-price strong")).toHaveText("€9");
    await expect(cards.nth(2).locator(".pricing-price strong")).toHaveText("€19");
    await expect(cards.nth(3).locator(".pricing-price strong")).toHaveText("€39");
    await expect(cards.nth(2).locator(".pricing-terms")).toHaveText("Billed every month");
    await expect(page.locator(".pricing-save")).toHaveCount(0);

    // Six months cost five: the headline drops to the effective monthly rate
    // and the terms name the amount actually charged.
    await page.getByRole("button", { name: "6 months" }).click();
    await expect(cards.nth(1).locator(".pricing-price strong")).toHaveText("€7.50");
    await expect(cards.nth(2).locator(".pricing-price strong")).toHaveText("€15.83");
    await expect(cards.nth(2).locator(".pricing-terms")).toContainText("€95 for 6 months");
    await expect(cards.nth(2).locator(".pricing-save")).toContainText("17%");
    await expect(cards.nth(0).locator(".pricing-price strong")).toHaveText("€0");

    // Twelve cost nine.
    await page.getByRole("button", { name: "12 months" }).click();
    await expect(cards.nth(3).locator(".pricing-price strong")).toHaveText("€29.25");
    await expect(cards.nth(3).locator(".pricing-terms")).toContainText("€351 for 12 months");
    await expect(cards.nth(3).locator(".pricing-save")).toContainText("25%");

    await expect(cards.nth(0).getByRole("link", { name: /Start free/ })).toHaveAttribute("href", "/login?mode=signup");
    await expect(
      cards.nth(2).getByRole("link", { name: /Start free trial/ }),
    ).toHaveAttribute("href", "/login?mode=signup");
    await expect(cards.nth(2)).toContainText("14 days of Studio free, no card");
    await expect(page.locator(".pricing-note")).toContainText("code FOUNDER30");
  });
});
