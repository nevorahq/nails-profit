import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  requestAppointmentAsClient,
  seedStudio,
  type Studio,
} from "../helpers/studio";

/**
 * One number, two people — reported from the studio as «пришла заявка не с тем
 * именем».
 *
 * A public request is matched to an existing client by number or address, and
 * the card it matches is deliberately left as the studio wrote it: otherwise
 * whoever holds the booking link gets to rename the studio's client, and every
 * appointment in the calendar is labelled from that one row. What used to
 * happen to the name typed on the form was nothing at all — it was read once,
 * to decide whether a card had to be made, and then dropped. So a request from
 * a daughter on her mother's number reached the master under the mother's name,
 * with nothing on any screen saying otherwise.
 *
 * The appointment now carries the name it was booked under, and the two screens
 * a master reads it on say both: who is coming, and whose card the visit joins.
 */
test.describe("a request made under a name the card does not carry", () => {
  let studio: Studio;

  test.beforeEach(async ({ baseURL }, testInfo) => {
    studio = await seedStudio(baseURL!, testInfo);
  });

  test.afterEach(async () => {
    if (studio) await disposeStudio(studio);
  });

  test("the bell names who is coming, and the card underneath", async ({
    browser,
    baseURL,
    browserErrors,
  }) => {
    void browserErrors;
    // The household: one phone, one address, two people using them.
    const household = { phone: "+373 69 414 141", email: "household@example.com" };
    const mothers = await requestAppointmentAsClient(baseURL!, studio, {
      date: daysFromToday(1),
      name: "Liuda",
      ...household,
    });
    const daughters = await requestAppointmentAsClient(baseURL!, studio, {
      date: daysFromToday(1),
      afterTime: "12:00",
      name: "Olga",
      ...household,
    });
    expect(mothers.status).toBe("pending_confirmation");
    expect(daughters.status).toBe("pending_confirmation");

    const context = await browser.newContext({ storageState: await studio.master.storageState() });
    const page = await context.newPage();
    await page.goto("/app/calendar");
    await page.getByRole("button", { name: "Notifications" }).click();

    const waiting = page.getByRole("menuitem");
    await expect(waiting).toHaveCount(2);

    // The first request made the card, so it has one name and says one name.
    await expect(waiting.nth(0)).toContainText("Liuda");
    await expect(waiting.nth(0)).not.toContainText("Client card");

    // The second is the one the studio was reading wrong: booked by Olga, filed
    // against Liuda's card, and until now shown as Liuda alone.
    await expect(waiting.nth(1)).toContainText("Olga");
    await expect(waiting.nth(1)).toContainText("Client card: Liuda");

    // And on the day itself, where the master works from.
    await waiting.nth(1).click();
    const entries = page.locator(".calendar-entry");
    const second = entries.filter({ hasText: "Olga" });
    await expect(second).toHaveCount(1);
    await second.locator("summary").first().click();
    await expect(second).toContainText("Client card: Liuda");

    await context.close();
  });
});
