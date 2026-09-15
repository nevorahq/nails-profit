import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, type Studio } from "../helpers/studio";

/**
 * What «Мастера» says about a row, and what it has stopped saying.
 *
 * The page used to answer with three notices at once about a studio that had
 * just hired somebody: a banner across the top counting masters without a
 * commission rule, «нельзя записать» beside the new name, and a dead «не
 * задана» in the rate column. Two of them were about a step the product now
 * takes itself — the card is created at every address with the studio's own
 * week on it — and the banner is the voice of a setup in progress, which a
 * studio that has finished setting up is not in.
 *
 * What is left is the one thing nobody else can do: the rate, said on the row
 * it belongs to and linking to the form that sets it.
 */
test.describe("the notices on the list of masters", () => {
  let studio: Studio;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterAll(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("an unset rate is the way to set it, and nothing else shouts", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;

    /*
     * A master with no rule, on a studio whose own setup is long since
     * finished: `seedStudio` registers with a rate and a priced service, so
     * `loadSetupGuide` answers null and the banner is not this page's business
     * any more. The owner's own card carries the principal mark, which is what
     * used to print «imputed cost of your own work» under every rate.
     */
    const unpaid = await studio.owner.post<{ id: string }>("/api/v1/specialists", {
      name: "Unpaid Una",
    });
    await studio.owner.post("/api/v1/specialists", {
      name: "Owner Olsen",
      is_me: true,
      default_rule: { type: "percentage", basis_points: 5_000 },
    });

    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    try {
      const page = await context.newPage();
      await page.goto("/app/specialists");

      await expect(page.getByText(/has no commission rule/)).toHaveCount(0);
      await expect(page.getByText("cannot be booked")).toHaveCount(0);
      await expect(page.getByText("imputed cost of your own work")).toHaveCount(0);

      /*
       * Who each of them is, beside how they are paid. The row used to print
       * «Владелец» for the working owner and nothing for anybody else, so a
       * studio of three read «процент» three times over. The word is the
       * account's own role — written lowercase, because that is how the rest
       * of the product says it in a sentence, and capitalised by `.badge-role`
       * where it stands alone as a label.
       */
      const row = (name: string) => page.getByRole("row").filter({ hasText: name });
      await expect(row(studio.specialistName).locator(".badge-role")).toHaveText("master");
      await expect(row("Owner Olsen").locator(".badge-role")).toHaveText("owner");
      // A card nobody's account is behind says nothing about a role it has not
      // got — «Unpaid Una» is a name in a catalogue, not a person who signs in.
      await expect(row("Unpaid Una").locator(".badge-role")).toHaveCount(0);

      // The one notice that is left, and it goes where the rule is set.
      const notSet = page.getByRole("link", { name: "not set" });
      await expect(notSet).toBeVisible();
      await expect(notSet).toHaveAttribute("href", `/app/specialists/${unpaid.id}`);

      await notSet.click();
      await expect(page).toHaveURL(new RegExp(`/app/specialists/${unpaid.id}$`));
      await expect(page.getByRole("heading", { name: "Unpaid Una" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
