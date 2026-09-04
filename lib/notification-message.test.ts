import { describe, expect, it } from "vitest";

import { supportedLocales } from "@/i18n/messages";
import {
  asBookingNotificationTemplate,
  bookingNotificationTemplates,
  formatAppointmentTime,
  renderNotification,
} from "@/lib/notification-message";

const base = {
  locale: "ru" as const,
  studioName: "Green Nails",
  when: "2 сент. 2026 г., 10:00",
  specialist: "Ирина",
  link: "https://example.test/booking/abc",
  linkIsOneTime: true,
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

  /**
   * The grey line under the button prints the address as text, which is what
   * survives a client whose sanitizer strips `<a>` and leaves the button as
   * dead words. It is worth a line of noise for a manage link — a token minted
   * for one appointment, held nowhere else, and unguessable by a client who has
   * no account — and worth nothing for the studio's own booking page, which is
   * on their materials already.
   */
  it("prints the address under the button only where losing it would strand the reader", () => {
    const managed = renderNotification({ ...base, template: "booking.confirmed" });
    expect(managed.html).toContain("Если кнопка не открывается");
    // Three: the button's href, the fallback's href, and the address printed
    // as the text a stripped anchor leaves behind.
    expect(managed.html.match(new RegExp(base.link, "g"))).toHaveLength(3);

    const publicPage = renderNotification({
      ...base,
      template: "booking.visit_completed",
      linkIsOneTime: false,
    });
    expect(publicPage.html).not.toContain("Если кнопка не открывается");
    // Still a button, and still the one link it needs.
    expect(publicPage.html.match(new RegExp(base.link, "g"))).toHaveLength(1);
  });

  it("carries the manage link in the messages a client acts on", () => {
    for (const template of [
      "booking.confirmed",
      "booking.request_accepted",
      "booking.rescheduled",
      "booking.reminder",
    ] as const) {
      expect(renderNotification({ ...base, template }).body).toContain(base.link);
    }
  });

  it("keeps the link in the plain text, where SMS is the only shape there is", () => {
    // The catalogue no longer welds the link into the sentence, so this is the
    // check that putting it back together still reads the way it always did.
    const confirmed = renderNotification({ ...base, template: "booking.confirmed" });
    expect(confirmed.body).toBe(
      `Green Nails: запись на 2 сент. 2026 г., 10:00 подтверждена.\n\nПеренести или отменить: ${base.link}`,
    );
  });

  it("gives email a button for the same action, in every language", () => {
    for (const locale of supportedLocales) {
      const confirmed = renderNotification({ ...base, locale, template: "booking.confirmed" });
      expect(confirmed.html).toContain(base.link);
      // The button's words come from the catalogue, so they are the locale's.
      const [, label] = /\n\n(.+): https/.exec(confirmed.body) ?? [];
      expect(label).toBeTruthy();
      expect(confirmed.html).toContain(label);
    }
  });

  it("sends the verification code with nothing to click", () => {
    const verification = renderNotification({ ...base, template: "booking.verification_code" });
    expect(verification.body).not.toContain(base.link);
    expect(verification.html).not.toContain("<a ");
  });

  it("leaves out the button when the studio has nowhere to send anyone back to", () => {
    // A completed visit at a studio with no public page: `bookingFacts` hands
    // the renderer an empty link rather than inventing one.
    const thanks = renderNotification({
      ...base,
      template: "booking.visit_completed",
      link: "",
    });
    expect(thanks.body).toBe("Спасибо, что были у нас 2 сент. 2026 г., 10:00.");
    expect(thanks.html).not.toContain("<a ");
  });

  it("names the master in the answer to a request, and only there", () => {
    // The client asked and a person said yes; the message says who, when, and
    // in the language the client chose.
    for (const locale of supportedLocales) {
      const accepted = renderNotification({ ...base, locale, template: "booking.request_accepted" });
      expect(accepted.body).toContain("Ирина");
      expect(accepted.body).toContain(base.when);
    }

    // A booking the studio made itself has nobody to name: the wording that
    // announces an acceptance must not leak into it.
    for (const template of bookingNotificationTemplates) {
      if (template === "booking.request_accepted") continue;
      expect(renderNotification({ ...base, template }).body).not.toContain("Ирина");
    }
  });
});

describe("a template read off a queued row", () => {
  it("is recognised when this build has wording for it", () => {
    for (const template of bookingNotificationTemplates) {
      expect(asBookingNotificationTemplate(template)).toBe(template);
    }
  });

  it("is refused when it was written by a newer deployment", () => {
    // The name is deliberately plausible: the queue is shared between builds,
    // and the one draining it is not always the one that filled it.
    expect(asBookingNotificationTemplate("booking.invoice_issued")).toBeNull();
    expect(asBookingNotificationTemplate("")).toBeNull();
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
