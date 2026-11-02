import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens the appointment window the way the screen in front of it offers.
 *
 * On a wide screen — and for anyone but the owner on a phone — that is the
 * round «+» the calendar draws itself. The owner's phone has the shell's «+»
 * instead, whose first entry is the same action, and the calendar's own button
 * stands down there so the two are never on screen together.
 */
export async function openBookingForm(page: Page): Promise<Locator> {
  const own = page.getByRole("button", { name: "Book a client" });
  if (await own.isVisible()) {
    await own.click();
  } else {
    await page.locator(".quick-actions-toggle").click();
    await page.getByRole("link", { name: "Book a client" }).click();
  }

  const dialog = page.getByRole("dialog", { name: "New appointment" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Picks the master by their face, as the form offers it: a row of round photos
 * with the name under each, not a select.
 */
export async function chooseSpecialist(dialog: Locator, name: string) {
  await dialog.locator(".master-picker-item", { hasText: name }).click();
}

/**
 * Starts a new client the way the desk does: types the name into the one
 * search and takes «New client», which opens the name and phone fields with
 * what was typed already in place. Enter does the same thing from the keyboard.
 */
export async function typeNewClient(dialog: Locator, name: string) {
  await dialog.getByRole("combobox", { name: "Client" }).fill(name);
  await dialog.getByRole("option", { name: `New client: ${name}` }).click();
  await expect(dialog.getByLabel("New client's name")).toHaveValue(name);
}

/**
 * Ticks a service in the form's list. Nothing is chosen for the desk, so a form
 * that books has to say what the appointment is for; the row's name starts with
 * the service's, then its length and price.
 */
export async function chooseService(dialog: Locator, name: string) {
  await dialog.getByRole("checkbox", { name: new RegExp(`^${name}`) }).check();
}
