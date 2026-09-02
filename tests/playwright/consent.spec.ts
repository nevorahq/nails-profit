import { expect, test } from "./fixtures";

test("cookie consent persists and can be changed", async ({ page, browserErrors }) => {
  void browserErrors;
  await page.context().clearCookies();
  await page.goto("/");

  const region = page.getByRole("region", { name: "Cookie consent" });
  await expect(region).toBeVisible();
  await region.getByRole("button", { name: "Decline" }).click();
  await expect(region).toBeHidden();

  await page.goto("/login");
  await expect(page.getByRole("region", { name: "Cookie consent" })).toHaveCount(0);

  await page.getByRole("button", { name: "Cookie settings" }).click();
  await expect(region).toBeVisible();
  await region.getByRole("button", { name: "Accept" }).click();

  const consent = await page.context().cookies();
  const saved = consent.find((cookie) => cookie.name === "npo_cookie_consent");
  expect(saved).toBeDefined();
  expect(JSON.parse(decodeURIComponent(saved!.value))).toMatchObject({ analytics: true });
});
