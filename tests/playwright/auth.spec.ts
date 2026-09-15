import { expect, test } from "./fixtures";

test.describe("authentication UI", () => {
  test("sign-in and sign-up modes expose the right fields", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto("/login");

    await expect(page.getByLabel("Your name")).toHaveCount(0);
    await page.getByRole("button", { name: "No account? Create one" }).click();
    await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
    await expect(page.getByLabel("Your name")).toBeVisible();
    await expect(page.getByRole("checkbox")).toBeVisible();

    await page.getByRole("button", { name: "Already have an account? Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByLabel("Your name")).toHaveCount(0);
  });

  test("an address with no account is refused, and carries over to registration", async ({
    page,
    browserErrors,
  }) => {
    /*
     * The screen this suite never watched, and the one every report of «вошёл
     * несуществующим аккаунтом» is about. A refused sign-in must stay where it
     * is: /app is reachable only with a session, so a redirect there would mean
     * an account had just been created or signed into.
     *
     * The address carries over rather than the interface jumping to
     * registration by itself — see `domain/auth-refusal.ts` for why the refusal
     * is answered without saying which half was wrong.
     */
    const address = `no-such-account-${Date.now()}@example.com`;

    await page.goto("/login");
    await page.getByLabel("Email").fill(address);
    await page.getByLabel("Password").fill("orchid-lacquer-42-crown");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator(".form-error")).toHaveText(
      "That address and password do not match. If you have no account yet, create one below.",
    );
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    await page.getByRole("button", { name: "No account? Create one" }).click();
    await expect(page.getByLabel("Email")).toHaveValue(address);

    /*
     * The refusal travels as a 401, and Chromium writes every failed response
     * to the console — so this is the one test in the suite whose own subject
     * trips the shared «no browser errors» check. The line is asserted rather
     * than waved through, everything else must still be empty, and the array is
     * cleared so the fixture's own assertion sees what it expects.
     */
    expect(browserErrors.filter((line) => line.includes("401"))).toHaveLength(1);
    expect(browserErrors.filter((line) => !line.includes("401"))).toEqual([]);
    browserErrors.length = 0;
  });

  test("invalid reset link and mismatched passwords are handled in the browser", async ({
    page,
    browserErrors,
  }) => {
    void browserErrors;
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { name: "The link is not valid" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );

    await page.goto("/reset-password?token=browser-test-token");
    await page.getByLabel("New password", { exact: true }).fill("orchid-test-123");
    await page.getByLabel("Repeat the password").fill("orchid-test-456");
    await page.getByRole("button", { name: "Save the password" }).click();
    await expect(page.locator(".form-error")).toHaveText("The passwords do not match");
  });

  test("a user can create an account and workspace end to end", async ({
    page,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const suffix = `${testInfo.project.name}-${Date.now()}-${testInfo.workerIndex}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    await page.goto("/login?mode=signup");
    await page.getByLabel("Your name").fill("Browser Owner");
    await page.getByLabel("Email").fill(`playwright-${suffix}@example.com`);
    await page.getByLabel("Password").fill("orchid-lacquer-42-crown");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
    await page.getByLabel("Name").fill(`Browser Studio ${Date.now()}`);
    await page.getByLabel("Address").fill("10 Test Street, Chisinau");
    await page.getByRole("radio", { name: "Studio" }).check();
    await page.getByLabel("Currency").selectOption("MDL");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(/\/app$/);
    await expect(
      page.getByRole("heading", { level: 2, name: "Add a specialist and their commission rule" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a specialist" })).toHaveAttribute(
      "href",
      "/app/specialists#add-specialist",
    );
  });
});
