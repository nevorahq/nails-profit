import { expect, test } from "../fixtures";

test.describe("public smoke", () => {
  test("landing page and its critical assets load", async ({ page, browserErrors }) => {
    void browserErrors;
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("Nail Profit OS");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-GB");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /Stop guessing\s*what a service earns\./,
    );
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

    const brokenImages = await page.locator("img").evaluateAll((images) =>
      images.filter((image) => !(image as HTMLImageElement).complete || (image as HTMLImageElement).naturalWidth === 0)
        .map((image) => (image as HTMLImageElement).src),
    );
    expect(brokenImages).toEqual([]);
  });

  test("authentication routes render and private pages redirect to sign in", async ({
    page,
    browserErrors,
  }) => {
    void browserErrors;
    await page.goto("/app");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("legal pages are reachable", async ({ page, browserErrors }) => {
    void browserErrors;
    for (const [path, heading] of [
      ["/privacy", "Privacy notice"],
      ["/terms", "Terms of use"],
    ] as const) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole("link", { name: /Back/ })).toHaveAttribute("href", "/");
    }
  });

  test("health and unauthenticated API contracts stay intact", async ({ request }) => {
    const health = await request.get("/api/health", { headers: { "x-request-id": "pw-smoke" } });
    expect(health.status()).toBe(200);
    expect(health.headers()["cache-control"]).toBe("no-store");
    expect(health.headers()["x-request-id"]).toBe("pw-smoke");
    expect(await health.json()).toEqual({ status: "ok", checks: { database: "ok" } });

    const services = await request.get("/api/v1/services", {
      headers: { "x-request-id": "pw-anonymous" },
    });
    expect(services.status()).toBe(401);
    expect(services.headers()["x-request-id"]).toBe("pw-anonymous");
    expect(await services.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", request_id: "pw-anonymous", field_errors: [] },
    });
  });
});
