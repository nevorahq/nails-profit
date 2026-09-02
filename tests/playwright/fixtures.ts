import { expect, test as base } from "@playwright/test";

type BrowserHealthFixtures = {
  browserErrors: string[];
};

/**
 * Every browser test is also a console/page-error test. A flow that looks right
 * but throws during hydration is not healthy, especially with async Server
 * Components where the browser is the supported test boundary.
 */
export const test = base.extend<BrowserHealthFixtures>({
  browserErrors: async ({ page, baseURL }, use) => {
    const errors: string[] = [];

    // Cookie consent has its own focused test. All other flows start with a
    // deterministic declined state so the fixed mobile banner cannot cover the
    // control the scenario is actually exercising.
    if (baseURL) {
      await page.context().addCookies([
        {
          name: "npo_cookie_consent",
          value: encodeURIComponent(
            JSON.stringify({ analytics: false, updatedAt: "2026-01-01T00:00:00.000Z" }),
          ),
          url: baseURL,
          sameSite: "Lax",
        },
      ]);
    }

    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

    await use(errors);

    expect(errors, "the page emitted browser errors").toEqual([]);
  },
});

export { expect } from "@playwright/test";
