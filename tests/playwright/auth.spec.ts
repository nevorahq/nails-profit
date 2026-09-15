import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { PASSWORD, signUp, uniqueSuffix } from "./helpers/studio";

test.describe("authentication UI", () => {
  test("sign-in and sign-up modes expose the right fields", async ({ page, browserErrors }) => {
    void browserErrors;
    await page.goto("/login");

    await expect(page.getByLabel("Studio name")).toHaveCount(0);
    await page.getByRole("button", { name: "No account? Create one" }).click();
    await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
    await expect(page.getByLabel("Studio name")).toBeVisible();
    await expect(page.getByRole("checkbox")).toBeVisible();

    await page.getByRole("button", { name: "Already have an account? Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByLabel("Studio name")).toHaveCount(0);
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

  test("keeps the consent to one line on the narrowest phone", async ({ page, browserErrors }) => {
    void browserErrors;
    /*
     * 320px, which is the narrowest screen the product claims to work on. The
     * sentence used to read «Я принимаю условия использования и ознакомился(-ась)
     * с уведомлением о конфиденциальности» — three lines there, pushing «Создать
     * аккаунт» off the first screenful. The documents keep their full names in
     * this card's own footer and on the pages themselves.
     */
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/login?mode=signup");
    await expect(page.getByLabel("Studio name")).toBeVisible();

    const consent = page.locator('label[for="legalAccepted"]');
    const box = await consent.boundingBox();
    const lineHeight = await consent.evaluate((element) =>
      parseFloat(getComputedStyle(element).lineHeight),
    );
    expect(Math.round((box?.height ?? 0) / lineHeight)).toBe(1);

    // Both documents still reachable from the consent itself.
    await expect(consent.getByRole("link")).toHaveCount(2);

    // The rule under the studio name is held to the same width: it used to
    // spell out «A–Z, digits, space and hyphen», which is what a refused field
    // says for itself through `title`.
    const rule = page.locator(".field-hint").first();
    const ruleBox = await rule.boundingBox();
    const ruleLine = await rule.evaluate((element) =>
      parseFloat(getComputedStyle(element).lineHeight),
    );
    expect(Math.round((ruleBox?.height ?? 0) / ruleLine)).toBe(1);
  });

  /** Registration, up to the one question the setup screen still asks. */
  async function signUpAndAddress(page: Page, suffix: string, studioName = "Browser Studio") {
    await page.goto("/login?mode=signup");
    // The studio, not the person: it is the name a client reads on a booking
    // link, and nothing in the product ever showed the owner's own.
    await page.getByLabel("Studio name").fill(studioName);
    await page.getByLabel("Email").fill(`playwright-${suffix}@example.com`);
    await page.getByLabel("Password").fill("orchid-lacquer-42-crown");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
    await page.getByLabel("Address").fill("10 Test Street, Chisinau");
  }

  test("somebody working alone is set up and costed by one press", async ({
    page,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const suffix = `${testInfo.project.name}-${Date.now()}-${testInfo.workerIndex}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    await signUpAndAddress(page, suffix, `Solo Studio ${Date.now()}`);

    /*
     * The address is the whole of it. A name, a rate, a price list and a
     * working week were all asked for here once; every one of them had an
     * answer the product could supply, so it supplies them.
     */
    await expect(page.getByLabel("Name")).toHaveCount(0);
    await expect(page.getByText("Services and prices")).toHaveCount(0);
    await expect(page.getByText("Working hours")).toHaveCount(0);

    // Online booking is on unless somebody says otherwise — safe to default
    // because every request waits for the owner's answer.
    await expect(page.getByRole("checkbox", { name: "Accept online bookings" })).toBeChecked();

    await page.getByRole("button", { name: "Continue" }).click();

    /*
     * No checklist, no «add a specialist», no first visit to invent: the owner
     * is catalogued with the workspace, and what the product owes them — what
     * an hour of work is worth — is on the screen that follows, computed from
     * the defaults registration wrote.
     */
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { level: 2, name: "Your figures" })).toBeVisible();
    const manicure = page.getByRole("row", { name: /Manicure/ });
    // 200.00 at 40%: 80.00 to the person doing the work, 120.00 kept — and the
    // hour is the hour, so the hourly is the same figure.
    await expect(manicure).toContainText("200");
    await expect(manicure).toContainText("80");
    await expect(manicure).toContainText("120");

    /*
     * And the page clients book on is already live, with its address on the
     * same screen. It used to be two switches deep in «Онлайн-запись» — a
     * screen a studio has no reason to open in its first week — and until they
     * were flipped, `/book/<slug>` answered 404.
     */
    await expect(page.getByRole("heading", { name: "Your booking page" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^\/book\// })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy the link" })).toBeVisible();
  });

  test("a studio whose owner works is costed like anybody else", async ({
    page,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const suffix = `${testInfo.project.name}-works-${Date.now()}-${testInfo.workerIndex}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    await signUpAndAddress(page, suffix);
    await page.getByRole("radio", { name: "Studio" }).check();

    // The owner keeps the tick, so she is catalogued as a master herself — and
    // says who she is, because the studio's own name would be a strange thing
    // for a client to pick out of a list of three people.
    await expect(page.getByRole("checkbox", { name: /I take clients/ })).toBeChecked();
    await page.getByLabel("Your name").fill("Irina");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { level: 2, name: "Your figures" })).toBeVisible();
  });

  test("a studio is left with the one thing only it can answer: who works there", async ({
    page,
    browserErrors,
  }, testInfo) => {
    void browserErrors;
    const suffix = `${testInfo.project.name}-studio-${Date.now()}-${testInfo.workerIndex}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    await signUpAndAddress(page, suffix);
    await page.getByRole("radio", { name: "Studio" }).check();
    await page.getByLabel("Currency").selectOption("MDL");

    /*
     * The owner is assumed to take clients — in the pilot the woman who owns
     * the studio is usually also standing at a table — and this one says she
     * does not. There is then nobody for the rate to belong to.
     */
    const takesClients = page.getByRole("checkbox", { name: /I take clients/ });
    await takesClients.uncheck();
    // And the question of what to call her card goes with it.
    await expect(page.getByLabel("Your name")).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();

    /*
     * So the single step left is the one thing the product must not guess:
     * who works here.
     */
    await expect(page).toHaveURL(/\/app$/);
    await expect(
      page.getByRole("heading", { level: 2, name: "Add a specialist and their commission rule" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a specialist" })).toHaveAttribute(
      "href",
      "/app/specialists#add-specialist",
    );
  });

  test("somebody arriving from an invitation is asked for herself, not for a studio", async ({
    page,
    browser,
    browserErrors,
    baseURL,
  }, testInfo) => {
    void browserErrors;
    const suffix = uniqueSuffix(testInfo);
    const invitedEmail = `pw-invited-${suffix}@example.com`;

    // A studio with an invitation waiting on it, made the way a studio makes
    // one: registration, then the owner's own «Пригласить» call.
    const owner = await signUp(baseURL!, {
      email: `pw-inviter-${suffix}@example.com`,
      name: `PW Invite ${suffix}`.slice(0, 60),
    });

    try {
      await owner.post("/api/v1/organizations", {
        name: `PW Invite ${suffix}`.slice(0, 60),
        type: "studio",
        currency: "MDL",
        locale: "en",
        address: "10 Test Street, Chisinau",
      });
      const invitation = await owner.post<{ token: string }>("/api/v1/invitations", {
        email: invitedEmail,
        role: "master",
      });

      await page.goto(`/join?token=${encodeURIComponent(invitation.token)}`);
      await page.getByRole("link", { name: "Create an account" }).click();

      /*
       * The registration this form used to draw for her asked «Название
       * студии» — for the studio that had just invited her, named on the card
       * she pressed to get here, which she does not own and cannot rename.
       * What she typed became `users.name`.
       */
      await expect(page.getByLabel("Studio name")).toHaveCount(0);
      const name = page.getByLabel("Your name");
      await expect(name).toBeVisible();
      // The address is the invitation's own: no other one can accept it.
      await expect(page.getByLabel("Email")).toHaveValue(invitedEmail);

      // Cyrillic, which the studio-name rule refused outright — in the
      // browser's language, to a woman whose name is Ирина.
      await name.fill("Ирина Попеску");
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Create account" }).click();

      // Registered and joined in one press, with no second trip through /join.
      await expect(page).toHaveURL(/\/app$/);

      /*
       * And the studio calls her by her own name. This list is «Мастера,
       * которым нужна карточка», and the button beside it creates that card
       * with the very name asked for above (`components/specialist-manager.tsx`).
       */
      const ownerContext = await browser.newContext({ storageState: await owner.storageState() });
      try {
        const ownerPage = await ownerContext.newPage();
        await ownerPage.goto("/app/specialists");
        await expect(ownerPage.getByText("Ирина Попеску")).toBeVisible();
      } finally {
        await ownerContext.close();
      }
    } finally {
      await owner.dispose();
    }
  });
});
