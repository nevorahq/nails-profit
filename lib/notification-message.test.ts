import { describe, expect, it } from "vitest";

import { supportedLocales } from "@/i18n/messages";
import {
  bookingNotificationTemplates,
  formatAppointmentTime,
  renderNotification,
} from "@/lib/notification-message";

const base = {
  locale: "ru" as const,
  studioName: "Green Nails",
  when: "2 сент. 2026 г., 10:00",
  link: "https://example.test/booking/abc",
  code: "123456",
};

describe("transactional templates", () => {
  it("render in every supported language", () => {
    // Gate 7: "RU/RO/EN не имеют missing keys в критических booking flow", and
    // a message is the one part of the flow the client cannot re-read on a page.
    for (const template of bookingNotificationTemplates) {
      for (const locale of supportedLocales) {
        const rendered = renderNotification({ ...base, template, locale });
        expect(rendered.subject.trim()).not.toBe("");
        expect(rendered.body.trim()).not.toBe("");
        expect(rendered.body).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("puts the code in the verification message and nowhere else", () => {
    const verification = renderNotification({ ...base, template: "booking.verification_code" });
    expect(verification.body).toContain("123456");

    for (const template of bookingNotificationTemplates) {
      if (template === "booking.verification_code") continue;
      expect(renderNotification({ ...base, template }).body).not.toContain("123456");
    }
  });

  it("carries the manage link in the messages a client acts on", () => {
    for (const template of ["booking.confirmed", "booking.rescheduled", "booking.reminder"] as const) {
      expect(renderNotification({ ...base, template }).body).toContain(base.link);
    }
  });
});

describe("appointment time", () => {
  it("is the location's wall clock, not the server's", () => {
    const at = new Date("2026-09-02T07:00:00.000Z");
    // Chișinău is UTC+3 in September; a message saying 07:00 would send a
    // client to the studio three hours early.
    expect(formatAppointmentTime(at, "Europe/Chisinau", "en")).toContain("10:00");
    expect(formatAppointmentTime(at, "UTC", "en")).toContain("7:00");
  });
});
