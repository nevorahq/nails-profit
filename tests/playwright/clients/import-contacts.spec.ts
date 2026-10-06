import { expect, test } from "../fixtures";
import { disposeStudio, seedStudio, signedInContext, type Studio } from "../helpers/studio";

/**
 * Clients from a phone, the way an owner meets it: an empty client list asks
 * «Do you already have clients?», «From my phone» opens the import with the
 * way to export contacts said first, and a .vcf becomes a list to tick from.
 *
 * The file is synthetic and built here; real phone books stay out of the repo.
 */
const crlf = (...lines: string[]) => `${lines.join("\r\n")}\r\n`;

const PHONE_BOOK = crlf(
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Maria Popescu",
  "TEL;TYPE=CELL:069 123 456",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Mama",
  "TEL;TYPE=cell:069 999 999",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Marina Kyiv",
  "TEL;TYPE=CELL:+380 50 123 45 67",
  "END:VCARD",
);

test.describe("clients from a phone's contacts", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("an empty client list leads to ticking clients out of a phone book", async ({
    baseURL,
    browser,
    browserErrors,
  }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/clients");
    await expect(page.getByRole("heading", { name: "Do you already have clients?" })).toBeVisible();
    await page.getByRole("link", { name: "From my phone" }).click();

    await expect(page).toHaveURL(/\/app\/import\?entity=client&from=phone#import-upload$/);
    await expect(page.getByText(/Clients from your phone: export your contacts/)).toBeVisible();
    await expect(page.getByLabel("What to import")).toHaveValue("client");

    await page.getByLabel("CSV file or contacts (.vcf)").setInputFiles({
      name: "contacts.vcf",
      mimeType: "text/vcard",
      buffer: Buffer.from(PHONE_BOOK, "utf8"),
    });
    await page.getByRole("button", { name: "Upload" }).click();

    // Nothing ticked: a phone book is mostly people who are not clients.
    await expect(page.getByRole("heading", { name: "Contacts from your phone" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(3);
    await expect(page.getByText("0 of 3 ticked")).toBeVisible();
    await expect(page.getByText("+380 50 123 45 67 not recognised — comes in without a phone")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByLabel("Search by name or number").fill("Mari");
    await expect(page.getByRole("checkbox")).toHaveCount(2);
    await page.getByRole("button", { name: "Tick all found (2)" }).click();
    // Searched by number too, written the way a person types it.
    await page.getByLabel("Search by name or number").fill("069 999");
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    await expect(page.getByRole("checkbox", { name: /Mama/ })).not.toBeChecked();
    await expect(page.getByText("2 of 3 ticked")).toBeVisible();

    await page.getByRole("button", { name: "Continue (2)" }).click();

    // The columns are ours, so there is nothing to match — straight to what will be written.
    await expect(page.getByRole("heading", { name: "What will be written" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Columns" })).toHaveCount(0);
    await page.getByRole("button", { name: /^Import 2/ }).click();
    await expect(page.getByRole("heading", { name: "Import finished" })).toBeVisible();

    await page.goto("/app/clients");
    await expect(page.getByText("Maria Popescu").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("Marina Kyiv").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("Mama").filter({ visible: true })).toHaveCount(0);
    // The list is no longer empty, so the question is not asked again.
    await expect(page.getByRole("heading", { name: "Do you already have clients?" })).toHaveCount(0);

    await context.close();
  });

  test("«Later» folds the question away", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.owner, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/clients");
    await page.getByRole("button", { name: "Later" }).click();
    await expect(page.getByRole("heading", { name: "Do you already have clients?" })).toHaveCount(0);

    await context.close();
  });

  test("a master is not offered an import they would be refused", async ({ baseURL, browser, browserErrors }) => {
    void browserErrors;
    const context = await signedInContext(browser, studio.master, baseURL!);
    const page = await context.newPage();

    await page.goto("/app/clients");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Do you already have clients?" })).toHaveCount(0);

    await context.close();
  });
});
