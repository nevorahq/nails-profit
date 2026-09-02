import { describe, expect, it } from "vitest";

import { normalizePhone } from "@/domain/phone";
import { normalizeVerificationCode } from "@/domain/verification-code";
import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";
import type { MessageKey } from "@/i18n/t";
import { validatePublicContact } from "@/lib/public-booking-ux";

describe("public booking contact validation", () => {
  it("returns field-level errors for an empty required form", () => {
    expect(
      validatePublicContact({ name: "", phone: "", email: "", legalAccepted: false }, true),
    ).toEqual({
      name: "required",
      phone: "required",
      email: "required",
      legalAccepted: "required",
    });
  });

  it("accepts a valid contact when email is optional", () => {
    expect(
      validatePublicContact(
        { name: "Ana", phone: "+373 69 123 456", email: "", legalAccepted: true },
        false,
      ),
    ).toEqual({});
  });

  it("rejects malformed values without trimming away valid input", () => {
    expect(
      validatePublicContact(
        { name: "A", phone: "12-3", email: "ana@invalid", legalAccepted: true },
        false,
      ),
    ).toEqual({ name: "nameTooShort", phone: "phoneInvalid", email: "emailInvalid" });
  });
});

describe("public booking placeholders", () => {
  /**
   * The examples shown in the empty fields are a promise the validator has to
   * keep: an example the form itself would reject teaches the client the one
   * format that cannot work.
   */
  it.each(supportedLocales)("%s offers examples the form accepts", (locale) => {
    const example = (key: MessageKey) => {
      const message = dictionaries[locale][key];
      return typeof message === "string" ? message : message.other;
    };

    const draft = {
      name: example("publicBooking.namePlaceholder"),
      phone: example("publicBooking.phonePlaceholder"),
      email: example("publicBooking.emailPlaceholder"),
      legalAccepted: true,
    };

    expect(validatePublicContact(draft, true)).toEqual({});
    // The client-side check only counts digits; the API normalizes to E.164.
    expect(normalizePhone(draft.phone)).not.toBeNull();
    expect(normalizeVerificationCode(example("publicBooking.codePlaceholder"))).not.toBeNull();
  });
});
