import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, type Studio } from "../helpers/studio";

/**
 * The question that stands between a studio and a removed client.
 *
 * It used to be `window.confirm()`: a window the page had no say in, written in
 * the browser's language over an application that speaks the studio's — and one
 * every automated browser answers by itself, so nothing about the question was
 * ever under test. Two things are worth protecting now that the page asks it.
 * That it is asked at all, and that the left button is a real way out: an owner
 * who clicks the bin and thinks better of it must still have the client.
 *
 * Both projects run this file, so the buttons are found by what is visible —
 * the table and the phone cards are both in the markup, and CSS alone decides
 * which of the two the studio is looking at.
 */
const CLIENT = "Marina Ceban";

type Page = import("@playwright/test").Page;

/** The row's own bin, in whichever of the two lists this viewport renders. */
function removeButton(page: Page) {
  return page.getByRole("button", { name: "Delete", exact: true }).filter({ visible: true }).first();
}

/**
 * Text as the studio reads it — the other list holds the same words, unseen.
 *
 * Loose by default: a hidden client's name shares its cell with the «Hidden»
 * badge, so an exact match would stop finding the row the moment it is put
 * away. The badge itself is asked for exactly, or it also answers to the
 * «Show hidden» toggle above it.
 */
function shown(page: Page, text: string, exact = false) {
  return page.getByText(text, { exact }).filter({ visible: true });
}

test.describe("removing a client from the list", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
    await studio.owner.post("/api/v1/clients", { name: CLIENT });
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("asks in the application's own window, and the left button keeps the client", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    // A browser dialog is dismissed by Playwright without anybody seeing it, so
    // its return here would look like a passing test rather than a failing one.
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.message());
      void dialog.dismiss();
    });

    await page.goto("/app/clients");
    await expect(shown(page, CLIENT).first()).toBeVisible();

    await removeButton(page).click();

    const window = page.getByRole("dialog");
    await expect(window).toContainText(`Remove contact ${CLIENT} from the list?`);
    expect(nativeDialogs, "the browser's own dialog answered instead of the page").toEqual([]);

    await window.getByRole("button", { name: "Cancel" }).click();

    await expect(window).toHaveCount(0);
    await expect(shown(page, CLIENT).first()).toBeVisible();
    await expect(shown(page, "Hidden", true)).toHaveCount(0);

    await context.close();
  });

  test("the right button removes it, and the list can still show it", async ({
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await browser.newContext({ storageState: await studio.owner.storageState() });
    const page = await context.newPage();

    await page.goto("/app/clients");
    await removeButton(page).click();

    const window = page.getByRole("dialog");
    await window.getByRole("button", { name: "Delete", exact: true }).click();

    // The window closes on its own once the request answers, and the client
    // leaves the working list — put away rather than erased, which is what the
    // toggle underneath proves.
    await expect(window).toHaveCount(0);
    await expect(page.getByText(CLIENT)).toHaveCount(0);

    await page.getByLabel("Show hidden: 1").check();
    await expect(shown(page, CLIENT).first()).toBeVisible();
    await expect(shown(page, "Hidden", true).first()).toBeVisible();

    await context.close();
  });
});
