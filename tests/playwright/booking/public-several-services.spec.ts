import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import {
  daysFromToday,
  disposeStudio,
  isoDate,
  seedStudio,
  useClientAddress,
  type Studio,
} from "../helpers/studio";

/**
 * A stranger booking a manicure and a pedicure in one sitting.
 *
 * Canonical studio — a 600 MDL manicure for 90 minutes — plus a 400 MDL pedicure
 * for 60 and a 200 MDL brow shape for 30. The page has to add the second
 * service, price and time the whole sitting, find a time it fits, and hand the
 * studio one appointment of two and a half hours; and it has to stop at three.
 */
async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const width of [null, 375] as const) {
  test.describe(`booking several services on the public page${width ? ` at ${width} px` : ""}`, () => {
    let studio: Studio;
    if (width) test.use({ viewport: { width, height: 812 } });

    test.beforeEach(async ({ baseURL, page }, testInfo) => {
      studio = await seedStudio(baseURL!, testInfo, { confirmationMode: "instant" });
      for (const [name, price, minutes] of [
        ["Pedicure", 40_000, 60],
        ["Brows", 20_000, 30],
        ["Lashes", 30_000, 45],
      ] as const) {
        await studio.owner.post("/api/v1/services", { name: { en: name }, price_minor: price, duration_minutes: minutes });
      }
      await useClientAddress(page, baseURL!);
    });

    test.afterEach(async () => {
      if (studio) await disposeStudio(studio);
    });

    test("two services are priced, timed and booked as one appointment", async ({ page, browserErrors }, testInfo) => {
      void browserErrors;
      await page.goto(`/book/${studio.slug}`);
      await expect(page.getByRole("combobox", { name: /^Service/ })).toHaveCount(1);
      await expect(page.locator(".public-booking-quote")).toContainText("MDL 600.00");

      await page.getByRole("button", { name: "+ Another service" }).click();
      await page.getByRole("combobox", { name: /^Service 2/ }).selectOption({ label: "Pedicure" });
      await expect(page.locator(".public-booking-quote")).toContainText("MDL 1,000.00");
      await expect(page.locator(".public-booking-quote")).toContainText("150");

      // Three at most: the third is offered, a fourth is not.
      await page.getByRole("button", { name: "+ Another service" }).click();
      await expect(page.getByRole("combobox", { name: /^Service 3/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "+ Another service" })).toHaveCount(0);
      await page.getByRole("button", { name: "Remove service 3" }).click();
      await expect(page.locator(".public-booking-quote")).toContainText("MDL 1,000.00");

      await noSidewaysScroll(page);
      await page.screenshot({ path: testInfo.outputPath("public-two-services.png"), fullPage: true });

      await page.getByLabel("Specialist").selectOption({ label: studio.specialistName });
      await page.getByLabel("Date").fill(isoDate(daysFromToday(2)));
      await page.getByRole("button", { name: "Show available times" }).click();
      const times = page.locator(".public-booking-slots button");
      await expect(times.first()).toBeVisible();
      await times.first().click();

      await expect(page.locator(".public-booking-summary")).toContainText("Manicure with coating + Pedicure");
      await page.getByLabel("Name").fill("Clara Two");
      await page.locator("#booking-phone").fill("+373 69 555 222");
      await page.locator("#booking-email").fill("clara-two@example.com");
      await page.locator("#booking-legalAccepted").check();
      await page.getByRole("button", { name: "Confirm booking" }).click();
      await expect(page.getByRole("heading", { name: "Appointment created" })).toBeVisible();

      // In the studio's calendar: one appointment, both services, the whole length.
      const booked = await studio.owner.get<
        { starts_at: string; ends_at: string; price_minor: number; lines: { kind: string }[] }[]
      >(`/api/v1/bookings?specialist_id=${studio.specialistId}`);
      expect(booked).toHaveLength(1);
      expect(booked[0].lines.filter((line) => line.kind === "service")).toHaveLength(2);
      expect(booked[0].price_minor).toBe(100_000);
      expect((new Date(booked[0].ends_at).getTime() - new Date(booked[0].starts_at).getTime()) / 60_000).toBe(150);
    });

    test("services nobody does together are not offered as one sitting", async ({ page, browserErrors }) => {
      void browserErrors;
      const catalogue = await studio.owner.get<{ id: string; name: Record<string, string> }[]>("/api/v1/services");
      const pedicure = catalogue.find((entry) => entry.name.en === "Pedicure")!;
      // One does hands, the other feet.
      await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/services`, {
        services: [{ service_id: studio.serviceId }],
      });
      await studio.owner.put(`/api/v1/specialists/${studio.colleagueId}/services`, {
        services: [{ service_id: pedicure.id }],
      });

      await page.goto(`/book/${studio.slug}`);
      await page.getByRole("button", { name: "+ Another service" }).click();
      await page.getByRole("combobox", { name: /^Service 2/ }).selectOption({ label: "Pedicure" });
      await expect(page.locator(".public-booking-card").getByRole("alert")).toContainText("No single specialist does all of these");
      await expect(page.getByRole("button", { name: "Show available times" })).toBeDisabled();

      // Back to one service, and the page books as before.
      await page.getByRole("button", { name: "Remove service 2" }).click();
      await expect(page.getByRole("button", { name: "Show available times" })).toBeEnabled();
    });
  });
}
