import type { TestInfo } from "@playwright/test";

import { expect, test } from "../fixtures";
import { signedInContext, signUp, uniqueSuffix } from "../helpers/studio";

/**
 * A studio with one address, as registration makes it, after the prices were
 * saved with «запись позже».
 *
 * Built through the endpoints the screens call, so the state is exactly the
 * one a new owner is in: a draft page, confirmed prices, a wish to book online.
 */
async function savedForLater(baseURL: string, testInfo: TestInfo) {
  const suffix = uniqueSuffix(testInfo);
  const owner = await signUp(baseURL, { email: `pw-switch-${suffix}@example.com`, name: "Switch Owner" });
  const organization = await owner.post<{ id: string; slug: string }>("/api/v1/organizations", {
    name: `PW Switch ${suffix}`.slice(0, 60),
    type: "solo",
    currency: "MDL",
    locale: "en",
    address: "1 Solo Street",
    timezone: "UTC",
    commission_basis_points: 4_000,
    services: [{ key: "manicure", price_minor: 30_000, duration_minutes: 60 }],
    workweek: { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "08:00", end: "20:00" },
    publish_booking: true,
  });
  const services = await owner.get<{ id: string }[]>("/api/v1/services");
  await owner.post("/api/v1/organizations/setup", {
    services: [{ id: services[0].id, price_minor: 30_000, duration_minutes: 60 }],
    workweek: { weekdays: [1, 2, 3, 4, 5, 6, 7], start: "08:00", end: "20:00" },
    open_booking: false,
  });
  return { owner, slug: organization.slug };
}

test.describe("a studio with one address", () => {
  test("is told its booking is closed, and led to open it", async ({ browser, baseURL, browserErrors }, testInfo) => {
    void browserErrors;
    const { owner } = await savedForLater(baseURL!, testInfo);
    const context = await signedInContext(browser, owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 2, name: "Your figures" })).toBeVisible();
    // No link to a page that would answer 404 — the way to open it instead.
    await expect(page.getByRole("link", { name: /^\/book\// })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Booking is still closed" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Check prices and open booking" })).toHaveAttribute("href", "/app/setup");

    await context.close();
    await owner.dispose();
  });

  for (const width of [null, 375] as const) {
    test(`opens and shuts its page with one switch${width ? ` at ${width} px` : ""}`, async ({
      browser,
      baseURL,
      browserErrors,
    }, testInfo) => {
      void browserErrors;
      const { owner, slug } = await savedForLater(baseURL!, testInfo);
      const context = await signedInContext(browser, owner, baseURL!);
      const page = await context.newPage();
      if (width) await page.setViewportSize({ width, height: 812 });
      const publicPage = () => page.request.get(`/api/v1/public/booking/${slug}`);

      await page.goto("/app/booking");
      const toggle = page.getByRole("switch", { name: "Online booking" });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      // The two controls it replaces are not offered beside it.
      await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open online booking" })).toHaveCount(0);
      expect((await publicPage()).status()).toBe(404);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      expect((await publicPage()).status()).toBe(200);
      await expect(page.getByRole("link", { name: "View as a client" }).first()).toHaveAttribute("href", `/book/${slug}`);
      await page.screenshot({ path: testInfo.outputPath("online-switch-on.png"), fullPage: true });

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      expect((await publicPage()).status()).toBe(404);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      await context.close();
      await owner.dispose();
    });
  }
});
