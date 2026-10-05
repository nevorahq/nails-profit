import { describe, expect, it } from "vitest";

import { supportedLocales } from "@/i18n/messages";
import { pushTemplates, renderPush, renderTestPush, type PushFacts } from "@/lib/push-message";

/**
 * A lock screen is read by whoever is standing next to the phone. These hold
 * what it may say: the event, the time, the service, the client's name — and
 * never a contact detail.
 */
const facts: Omit<PushFacts, "template" | "locale"> = {
  when: "6 окт., 14:00",
  service: "Маникюр с покрытием",
  client: "Анна",
  specialist: null,
  bookingId: "11111111-1111-4111-8111-111111111111",
};

describe("a push on a locked phone", () => {
  it("says the time, the service and the client's name, in every language", () => {
    for (const locale of supportedLocales) {
      for (const template of pushTemplates) {
        const payload = renderPush({ ...facts, template, locale });
        expect(payload.title.length).toBeGreaterThan(0);
        expect(payload.body).toContain(facts.when);
        expect(payload.body).toContain(facts.service);
        expect(payload.body).toContain("Анна");
      }
    }
  });

  it("carries no phone number or email address in any language", () => {
    for (const locale of supportedLocales) {
      for (const template of pushTemplates) {
        // What the lock screen shows; `url` and `tag` carry the booking's id.
        const { title, body } = renderPush({ ...facts, template, locale });
        const text = `${title}\n${body}`;
        expect(text).not.toMatch(/\+?\d[\d\s()-]{7,}\d/);
        expect(text).not.toContain("@");
      }
    }
    // The renderer has nowhere to put one: the facts type has no such field.
    expect(Object.keys(facts).sort()).toEqual(["bookingId", "client", "service", "specialist", "when"]);
  });

  it("names the chair only for a reader whose chair it is not", () => {
    const own = renderPush({ ...facts, template: "booking.staff_requested", locale: "ru" });
    const owners = renderPush({
      ...facts,
      specialist: "Ирина",
      template: "booking.staff_requested",
      locale: "ru",
    });
    expect(own.body).not.toContain("Ирина");
    expect(owners.body).toContain("к Ирина");
  });

  it("opens the appointment, and keeps one line per appointment", () => {
    const payload = renderPush({ ...facts, template: "booking.staff_request_reminder", locale: "ro" });
    expect(payload.url).toBe(`/app/calendar/${facts.bookingId}`);
    expect(payload.tag).toBe(`booking:${facts.bookingId}`);
  });

  it("says something for a booking with no client", () => {
    const payload = renderPush({ ...facts, client: null, template: "booking.staff_booked", locale: "en" });
    expect(payload.body).toContain("No client");
  });

  it("has a test message in every language", () => {
    for (const locale of supportedLocales) {
      const payload = renderTestPush(locale);
      expect(payload.title).not.toMatch(/^push\./);
      expect(payload.body).not.toMatch(/^push\./);
      expect(payload.url).toBe("/app");
    }
  });
});
