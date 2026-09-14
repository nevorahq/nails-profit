import { describe, expect, it } from "vitest";

import { supportedLocales } from "@/i18n/messages";
import {
  asBookingNotificationTemplate,
  bookingNotificationTemplates,
  formatAppointmentTime,
  isStaffNotificationTemplate,
  messageCarriesLink,
  renderNotification,
  smsFallbackTemplates,
  smsNotificationTemplates,
  smsReplacesEmail,
  staffNotificationTemplates,
} from "@/lib/notification-message";

const base = {
  channel: "email" as const,
  locale: "ru" as const,
  studioName: "Green Nails",
  when: "2 сент. 2026 г., 10:00",
  specialist: "Ирина",
  businessType: "studio" as const,
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
        // Both shapes: the reminder differs between them, and a message that
        // renders empty on one channel is as broken as one that renders empty
        // on both.
        for (const channel of ["email", "sms"] as const) {
          // And both shapes of business: four of the staff messages are
          // written twice, and a solo variant nobody translated would reach a
          // studio's phone as an empty SMS.
          for (const businessType of ["solo", "studio"] as const) {
            const rendered = renderNotification({ ...base, template, locale, channel, businessType });
            expect(rendered.subject.trim()).not.toBe("");
            expect(rendered.body.trim()).not.toBe("");
            expect(rendered.body).not.toMatch(/\{\w+\}/);
          }
        }
      }
    }
  });

  it("stops telling a woman working alone about a third person", () => {
    /*
     * The dispatcher collapses the owner's copy exactly when the master is the
     * owner, so in a studio of one these four arrive at the person they are
     * about — and arrived reading «Клиент отменил визит к мастеру Ирина», sent
     * to Ирина.
     */
    const named = ["booking.staff_booked", "booking.staff_rescheduled", "booking.staff_cancelled", "booking.staff_released"] as const;

    for (const template of named) {
      expect(renderNotification({ ...base, template }).body).toContain("Ирина");
      expect(renderNotification({ ...base, template, businessType: "solo" }).body).not.toContain(
        "Ирина",
      );
      // The hour is the point of all four, and it survives the rewrite.
      expect(renderNotification({ ...base, template, businessType: "solo" }).body).toContain(
        base.when,
      );
    }
  });

  it("leaves the client's own messages alone", () => {
    // «заявка принята мастером Ирина» is read by the client, who has every
    // reason to be told whose chair they are booked into.
    const accepted = renderNotification({
      ...base,
      template: "booking.request_accepted",
      businessType: "solo",
    });
    expect(accepted.body).toContain("Ирина");
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

  /**
   * A reminder is the one message the studio pays for on a schedule rather than
   * in answer to something, and the link is most of what it would pay for: a
   * one-time token on a long domain against 67 Cyrillic characters to a joined
   * segment. The sentence still has to survive losing it — a reminder that
   * reads as a fragment is worse than a long one.
   */
  it("drops the link from the reminder on SMS and keeps it in the email", () => {
    const sms = renderNotification({ ...base, template: "booking.reminder", channel: "sms" });
    expect(sms.body).not.toContain(base.link);
    expect(sms.body).toBe("Green Nails: напоминаем о записи 2 сент. 2026 г., 10:00.");

    const email = renderNotification({ ...base, template: "booking.reminder", channel: "email" });
    expect(email.body).toContain(base.link);
    expect(email.html).toContain(base.link);
  });

  /**
   * The reminder used to be the only message SMS stripped the link from, and
   * this test used to assert that every other one kept it on both channels.
   *
   * That held while the reminder was the only thing SMS ever carried. It is
   * not any more: a client with no email address now gets a cancellation or a
   * move by SMS, and those are exactly the messages where paying four segments
   * to carry a 120-character one-time token would matter most. So the rule is
   * about the channel now, not about one template — see `messageCarriesLink`.
   *
   * Nothing is lost. The email still carries the link for everyone who has an
   * inbox; a cancelled appointment has nothing left to manage; and a move
   * states its new time in the sentence itself.
   */
  it("keeps the link in the email and never in the SMS", () => {
    for (const template of [
      "booking.confirmed",
      "booking.request_accepted",
      "booking.rescheduled",
      "booking.link_reissued",
      "booking.cancelled",
    ] as const) {
      const sms = renderNotification({ ...base, template, channel: "sms" });
      const email = renderNotification({ ...base, template, channel: "email" });

      expect(sms.body, template).not.toContain(base.link);
      expect(email.body, template).toContain(base.link);
      // And the SMS is still a whole sentence rather than a truncated email.
      expect(sms.body.endsWith("."), template).toBe(true);
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

  it("names the master where the reader needs the name, and nowhere else", () => {
    // The client asked and a person said yes; the message says who, when, and
    // in the language the client chose.
    for (const locale of supportedLocales) {
      const accepted = renderNotification({ ...base, locale, template: "booking.request_accepted" });
      expect(accepted.body).toContain("Ирина");
      expect(accepted.body).toContain(base.when);
    }

    /*
     * And the studio's own messages about what a client did, because the owner
     * gets a copy of every one of them: they are reading about a chair that is
     * not theirs, and the name is the difference between the message and a trip
     * to the calendar to work out whose day just changed.
     *
     * `staff_requested` is the exception by age rather than by argument — its
     * wording predates the other three and is not worth rewriting to prove a
     * point about consistency.
     */
    for (const template of staffNotificationTemplates) {
      if (template === "booking.staff_requested") continue;
      if (template === "booking.staff_assigned") continue;
      for (const locale of supportedLocales) {
        expect(renderNotification({ ...base, locale, template }).body).toContain("Ирина");
      }
    }

    /*
     * And the one message in that set with a single reader, which is why it is
     * the one that names nobody.
     *
     * The argument above is about the owner's copy: they read about a chair
     * that is not theirs and the name is what saves them a trip to the
     * calendar. A booking made at the desk has no owner's copy — the owner is
     * usually the person who made it — so the only reader is the master whose
     * hour it is, and the name in a third-person sentence would be their own.
     * It says «вам» instead, and still has to say when.
     */
    for (const locale of supportedLocales) {
      const assigned = renderNotification({ ...base, locale, template: "booking.staff_assigned" });
      expect(assigned.body).not.toContain("Ирина");
      expect(assigned.body).toContain(base.when);
    }

    // A booking the studio made itself has nobody to name: the wording that
    // announces an acceptance must not leak into it.
    for (const template of bookingNotificationTemplates) {
      if (template === "booking.request_accepted") continue;
      if (isStaffNotificationTemplate(template)) continue;
      expect(renderNotification({ ...base, template }).body).not.toContain("Ирина");
    }
  });

  /**
   * The rule a studio is billed by, in one assertion.
   *
   * SMS is the message that arrives into a day which has moved on, and that is
   * the whole of what it is for. Everything else — a client answered while they
   * are still looking at the screen that caused it, and every message addressed
   * to the studio, who have an account with an address and no phone number at
   * all — travels by email. Written as an equality rather than as four absences
   * so that adding a template to the paid channel has to be a decision somebody
   * makes here on purpose.
   */
  it("keeps SMS to the one message nobody is expecting", () => {
    expect([...smsNotificationTemplates]).toEqual(["booking.reminder"]);
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

  const at = new Date("2026-09-11T11:00:00.000Z");

  it("keeps the year in an email and drops it from an SMS", () => {
    expect(formatAppointmentTime(at, "Europe/Chisinau", "ru", "email")).toContain("2026");
    expect(formatAppointmentTime(at, "Europe/Chisinau", "ru", "sms")).not.toContain("2026");
  });

  it("still names the day and the hour without it", () => {
    const sms = formatAppointmentTime(at, "Europe/Chisinau", "ru", "sms");
    expect(sms).toContain("11");
    expect(sms).toContain("14:00");
  });

  /**
   * `Intl` throws on a format that mixes `dateStyle`/`timeStyle` with the
   * individual components, which inside the dispatcher would fail the send
   * rather than shorten it. Every language, because the options are shared and
   * a throw here would take the whole channel down.
   */
  it.each(supportedLocales)("builds without throwing for %s", (locale) => {
    expect(() => formatAppointmentTime(at, "Europe/Chisinau", locale, "sms")).not.toThrow();
  });

  /**
   * The arithmetic the short format exists for. Cyrillic is UCS-2: 70
   * characters while the message fits in one segment, 67 apiece once it does
   * not. With the year, this studio's cancellation is 69 of those 70 — inside
   * the limit by a single character, so a name two letters longer doubles what
   * the studio pays. Nine characters of margin is the difference.
   */
  it("leaves a cancellation room to grow inside one segment", () => {
    const when = formatAppointmentTime(at, "Europe/Chisinau", "ru", "sms");
    const body = `Студия красоты Анастасии: запись на ${when} отменена.`;

    expect(body.length).toBeLessThanOrEqual(70);
    // Not merely inside it — far enough inside that a longer studio name is not
    // an invoice. The same sentence with the year is 69.
    expect(body.length).toBeLessThanOrEqual(62);
  });
});

describe("SMS as a replacement for an inbox", () => {
  /**
   * The list is short on purpose and the reason is money: a studio pays per
   * message, and these three are the only ones whose absence puts a client
   * outside a locked door, in a chair nobody is expecting them in, or waiting
   * on an answer that was given hours ago.
   */
  it("carries only what a client cannot afford to miss", () => {
    expect([...smsFallbackTemplates].sort()).toEqual([
      "booking.cancelled",
      "booking.request_accepted",
      "booking.rescheduled",
    ]);
  });

  it("sends a cancellation the studio decided on", () => {
    expect(smsReplacesEmail("booking.cancelled", "staff")).toBe(true);
  });

  /**
   * The maintenance job's cancellation of a request nobody answered — the case
   * with no human on either end, and the one the client has heard nothing about
   * since «студия подтвердит».
   */
  it("sends a request that lapsed on its own", () => {
    expect(smsReplacesEmail("booking.cancelled", "system")).toBe(true);
  });

  it("says nothing to a client about their own decision", () => {
    expect(smsReplacesEmail("booking.cancelled", "client")).toBe(false);
  });

  it("sends a move whoever made it, there being no record of who did", () => {
    expect(smsReplacesEmail("booking.rescheduled", null)).toBe(true);
  });

  /**
   * The answer to a request, which is the one acceptance nobody is watching
   * for: it comes when somebody in the studio next opens the calendar, up to
   * `confirmation_due_at` later. A client who gave only a number was queued
   * nothing at all for it — no SMS by the old rule, and no address for the
   * email — so their request was answered and the answer reached no one.
   */
  it("sends the answer to a request, which arrives long after it was asked", () => {
    expect(smsReplacesEmail("booking.request_accepted", null)).toBe(true);
  });

  /**
   * And not its neighbour. `booking.confirmed` covers an appointment that was
   * never a request — taken at the desk, or confirmed by the studio's instant
   * setting — where the client was there while it was made.
   */
  it.each([
    "booking.confirmed",
    "booking.pending_confirmation",
    "booking.visit_completed",
    "booking.link_reissued",
  ] as const)("leaves %s to email alone", (template) => {
    expect(smsReplacesEmail(template, null)).toBe(false);
  });

  /**
   * The confirmation in the shape it is paid for.
   *
   * Its own sentence — «ваша заявка принята мастером Ирина. Визит забронирован
   * на …» — is eighty-eight characters with an ordinary studio name, which in
   * UCS-2 is two segments and twice the price for the same three facts. The
   * short one keeps the studio, the acceptance and the hour, and is measured
   * here against a long name so that nobody can grow it back by a word.
   */
  it("says the acceptance in one segment, in every language", () => {
    const at = new Date("2026-09-11T11:00:00.000Z");
    for (const locale of supportedLocales) {
      const when = formatAppointmentTime(at, "Europe/Chisinau", locale, "sms");
      const sms = renderNotification({
        ...base,
        locale,
        channel: "sms",
        studioName: "Студия красоты Анастасии",
        when,
        template: "booking.request_accepted",
      });

      expect(sms.body.length, `${locale}: ${sms.body}`).toBeLessThanOrEqual(70);
      expect(sms.body).toContain(when);
      // The master's name is what was cut. The email below still has it.
      expect(sms.body).not.toContain("Ирина");
    }
  });

  it("keeps the master's name where the line is free", () => {
    const email = renderNotification({ ...base, template: "booking.request_accepted" });
    expect(email.body).toContain("Ирина");
  });

  /**
   * A manage link is a one-time token on a long domain — around 120 characters
   * against 67 a segment — so carrying one would cost four segments to say what
   * the message already says in one.
   */
  it("carries no link on any of them", () => {
    for (const template of bookingNotificationTemplates) {
      expect(messageCarriesLink(template, "sms"), template).toBe(false);
    }
  });
});
