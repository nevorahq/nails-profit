import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * «К выплате»: what each master earned this month and the press that marks it
 * paid. Canonical studio: a 600 MDL visit at 40% leaves the master 240 owed.
 */
for (const width of [null, 375] as const) {
  test.describe(`payouts${width ? ` at ${width} px` : ""}`, () => {
    let studio: Studio;
    if (width) test.use({ viewport: { width, height: 812 } });

    test.beforeEach(async ({ baseURL }, testInfo) => {
      studio = await seedStudio(baseURL!, testInfo);
      await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: studio.specialistId,
        actual_duration_minutes: 90,
      });
    });

    test.afterEach(async () => {
      if (studio) await disposeStudio(studio);
    });

    test("states what a master earned and marks it paid", async ({ browser, baseURL, browserErrors }, testInfo) => {
      void browserErrors;
      const context = await signedInContext(browser, studio.owner, baseURL!);
      try {
        const page = await context.newPage();
        await page.goto("/app/reports/payouts");

        await expect(page.getByRole("link", { name: "To pay out" })).toHaveAttribute("aria-current", "page");
        await expect(page.getByText(/No payouts marked yet/)).toBeVisible();
        const card = page.getByRole("region", { name: studio.specialistName });
        await expect(card).toContainText("MDL 240.00");

        // No horizontal scroll at a phone's width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);

        await card.getByRole("button", { name: "Mark a payout" }).click();
        await expect(card.getByLabel("Amount, MDL")).toHaveValue("240.00");
        await page.screenshot({ path: testInfo.outputPath("payout-form.png"), fullPage: true });
        await card.getByRole("button", { name: "Mark", exact: true }).click();

        await expect(page.getByText(/Payouts are tracked from/)).toBeVisible();
        await expect(card.locator(".payout-figures")).toContainText("Paid");
        await expect(card.locator(".payout-figures")).toContainText("MDL 0.00");
        await expect(page.getByRole("heading", { name: "Payouts this month" })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("payout-marked.png"), fullPage: true });

        // The month's cash flow now reads the payout, not the commission.
        await page.goto("/app/reports/month");
        await expect(page.locator("main")).toContainText("Paid to masters");
      } finally {
        await context.close();
      }
    });

    test("is refused to a master, whatever the address", async ({ browser, baseURL, browserErrors }) => {
      void browserErrors;
      const context = await signedInContext(browser, studio.master, baseURL!);
      try {
        const page = await context.newPage();
        await page.goto("/app/reports/payouts");
        await expect(page.getByText("Only the owner sees payouts to masters.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Mark a payout" })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}
