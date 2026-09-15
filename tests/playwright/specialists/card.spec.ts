import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, type Studio } from "../helpers/studio";

/**
 * A master's own card, and the two things it used to state without helping.
 *
 * «Комиссия по умолчанию — не задана» sat at the top of the page and the form
 * that answers it is four panels down, far enough that the two were never on
 * screen together. «Часов нет» sat lower still and pointed at «Онлайн-запись»,
 * two selects deep — which is the whole journey a card created today no longer
 * needs, because it is given the studio's own week when it is made. What was
 * left was everybody hired before that, and this is where they are seen.
 *
 * Gone from the page with the same edit: the order panel, and the two
 * paragraphs explaining rules nobody had asked about yet.
 */
test.describe("a master's card", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("names what is missing and is where it gets fixed", async ({ browser, browserErrors }) => {
    void browserErrors;

    /*
     * A card in the state everybody hired before the default week is in: at an
     * address, with no hours and no rule. Made by taking the hours away at the
     * studio's published address, which is the one honest way to reach it now
     * that creating a card writes them.
     */
    const stranded = await studio.owner.post<{ id: string }>("/api/v1/specialists", {
      name: "Hourless Hana",
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: stranded.id,
      location_id: studio.locationId,
      effective_from: new Date().toISOString().slice(0, 10),
      intervals: [],
    });

    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    try {
      const page = await context.newPage();
      await page.goto(`/app/specialists/${stranded.id}`);

      // What the page no longer carries.
      await expect(page.getByRole("heading", { name: "Order", exact: true })).toHaveCount(0);
      await expect(page.getByText(/takes precedence over the default commission/)).toHaveCount(0);
      await expect(page.getByText(/An empty selection means/)).toHaveCount(0);

      // The rate, now the way down to the form that sets it.
      await expect(page.getByRole("link", { name: "not set" })).toHaveAttribute(
        "href",
        "#commission",
      );

      /*
       * And the week, in one press rather than on another screen. The verdict
       * on the whole card is the banner; the address it is true of is the row
       * — this studio has two, and only one of them lost its hours.
       */
      const central = page.getByRole("listitem").filter({ hasText: "Central" });
      await expect(page.locator(".warning-banner").filter({ hasText: "no hours" })).toBeVisible();
      await expect(central).toContainText("no hours");

      await page.getByRole("button", { name: "Set the working week" }).click();

      await expect(central).toContainText("Monday");
      await expect(central).toContainText("Friday");
      await expect(central).not.toContainText("no hours");
      await expect(page.locator(".warning-banner").filter({ hasText: "no hours" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Set the working week" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
