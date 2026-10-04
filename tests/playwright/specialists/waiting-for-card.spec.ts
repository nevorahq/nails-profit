import { expect, test } from "../fixtures";
import {
  disposeStudio,
  seedStudio,
  signUp,
  signedInContext,
  uniqueSuffix,
  type Studio,
} from "../helpers/studio";

/**
 * «Ждут карточки», and what its one button does.
 *
 * It used to write the card on the spot, linked and without a rate — and a
 * master without a rate is one whose every visit refuses to close, which the
 * studio found out at the end of that master's first appointment. The button
 * now opens «Добавить мастера» with the person already chosen, and that form
 * will not create a card without a rate.
 */
test.describe("a member waiting for a card", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("is added with a rate and their account, in the add form", async ({
    baseURL,
    browser,
    browserErrors,
  }, testInfo) => {
    void browserErrors;

    const email = `pw-waiting-${uniqueSuffix(testInfo)}@example.com`;
    const invitation = await studio.owner.post<{ token: string }>("/api/v1/invitations", {
      email,
      role: "master",
    });
    const waiting = await signUp(baseURL!, { email, name: "Wendy Waiting" });
    await waiting.post("/api/v1/invitations/accept", { token: invitation.token });
    const session = (await (await waiting.request.get("/api/auth/get-session")).json()) as {
      user?: { id?: string };
    };

    const context = await signedInContext(browser, studio.owner, baseURL!);
    try {
      const page = await context.newPage();
      await page.goto("/app/specialists");

      const panel = page.locator("section").filter({ hasText: "Waiting for a card" });
      await expect(panel).toContainText("Wendy Waiting");
      await panel.getByRole("button", { name: "Add as a master" }).click();

      // Nothing written yet: the press ends on the form, not in the database.
      const before = await studio.owner.get<{ name: string }[]>("/api/v1/specialists");
      expect(before.map((person) => person.name)).not.toContain("Wendy Waiting");

      await expect(page.locator('#add-specialist input[name="name"]')).toHaveValue("Wendy Waiting");
      await expect(page.getByText(`The card will be linked to the account ${email}`)).toBeVisible();
      // The card is hers, so «Это я» is not offered beside it.
      await expect(page.getByRole("checkbox", { name: /This is me/ })).toHaveCount(0);

      const rate = page.locator('input[name="rule_value"]');
      await expect(rate).toBeFocused();
      await rate.fill("35");
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(panel).toHaveCount(0);

      const after = await studio.owner.get<
        { name: string; user_id: string | null; default_rule: { basis_points: number | null } | null }[]
      >("/api/v1/specialists");
      expect(after.find((person) => person.name === "Wendy Waiting")).toMatchObject({
        user_id: session.user?.id,
        default_rule: { basis_points: 3_500 },
      });
    } finally {
      await context.close();
      await waiting.dispose();
    }
  });
});
