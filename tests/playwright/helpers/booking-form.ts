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
