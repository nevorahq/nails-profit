import { describe, expect, it } from "vitest";

import { normalizePhone } from "@/domain/phone";
import { normalizeVerificationCode } from "@/domain/verification-code";
import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";
import type { MessageKey } from "@/i18n/t";
import {
  bookingRequestSignature,
  publicBookingErrorKey,
  readApiError,
  retryAfterMinutes,
  toContactFieldErrors,
  validatePublicContact,
} from "@/lib/public-booking-ux";

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

describe("public booking api errors", () => {
  const refusal = (error: Record<string, unknown>) => ({ error });

  it("reads the code, the fields, the wait and the request id off a refusal", () => {
    expect(
      readApiError(
        refusal({
          code: "VALIDATION_ERROR",
          request_id: "req-7",
          field_errors: [{ field: "phone", code: "too_small", message: "too short" }],
          details: { retry_after_seconds: 90 },
        }),
        422,
      ),
    ).toEqual({
      code: "VALIDATION_ERROR",
      status: 422,
      fieldErrors: [{ field: "phone", code: "too_small", message: "too short" }],
      retryAfterSeconds: 90,
      requestId: "req-7",
    });
  });

  it("survives a body that is not the error shape at all", () => {
    // A 502 from the edge, or an HTML page: `json()` gives null and the form
    // still has to say something.
    expect(readApiError(null, 502)).toEqual({
      code: null,
      status: 502,
      fieldErrors: [],
      retryAfterSeconds: null,
      requestId: null,
    });
    expect(readApiError({ error: { field_errors: "nope", request_id: 7 } }, 500).fieldErrors).toEqual(
      [],
    );
  });

  it("blames the service, not the client, for a 5xx", () => {
    expect(publicBookingErrorKey(readApiError(null, 500))).toBe("publicBooking.serverError");
  });

  it("falls back to the generic message only for a code it has never heard of", () => {
    expect(publicBookingErrorKey(readApiError(refusal({ code: "NEW_CODE" }), 409))).toBe(
      "publicBooking.error",
    );
  });

  /**
   * The regression this whole module exists for: a client refused because they
   * had tried ten times in an hour was told to check their name. Every code the
   * public surface can answer with must reach a message of its own — a new one
   * added to a route belongs in `ERROR_MESSAGES` in the same commit.
   */
  it.each([
    "SLOT_UNAVAILABLE",
    "SLOT_OR_CONTACT_CONFLICT",
    "HOLD_EXPIRED",
    "HOLD_MISMATCH",
    "SERVICE_NOT_BOOKABLE",
    "VERIFICATION_FAILED",
    "VERIFICATION_EXPIRED",
    "VERIFICATION_LOCKED",
    "VERIFICATION_REQUIRED",
    "VERIFICATION_NOT_REQUIRED",
    "CHALLENGE_REQUIRED",
    "CONTACT_CONFLICT",
    "IDEMPOTENCY_KEY_REUSED",
    "IDEMPOTENCY_KEY_REQUIRED",
    "VALIDATION_ERROR",
    "INVALID_PHONE",
    "INVALID_EMAIL",
    "BOOKING_PAGE_NOT_FOUND",
    "PREVIEW_READ_ONLY",
    "VERSION_CONFLICT",
    "CANNOT_RESCHEDULE",
    "ILLEGAL_TRANSITION",
    "RATE_LIMITED",
  ])("%s says something of its own", (code) => {
    const key = publicBookingErrorKey(readApiError(refusal({ code }), 409));
    expect(key).not.toBe("publicBooking.error");
    expect(dictionaries.ru[key]).toBeTruthy();
  });

  it("only promises a minute when the refusal named one", () => {
    const withWait = readApiError(
      refusal({ code: "RATE_LIMITED", details: { retry_after_seconds: 125 } }),
      429,
    );
    expect(publicBookingErrorKey(withWait)).toBe("publicBooking.rateLimitedIn");
    expect(retryAfterMinutes(withWait)).toBe(3);

    const withoutWait = readApiError(refusal({ code: "RATE_LIMITED" }), 429);
    expect(publicBookingErrorKey(withoutWait)).toBe("publicBooking.rateLimited");
  });

  it("never asks anyone to wait zero minutes", () => {
    expect(
      retryAfterMinutes(readApiError(refusal({ details: { retry_after_seconds: 4 } }), 429)),
    ).toBe(1);
  });
});

describe("public booking server field errors", () => {
  const withFields = (fields: { field: string; code: string }[]) =>
    readApiError(
      { error: { code: "VALIDATION_ERROR", field_errors: fields.map((f) => ({ ...f, message: "" })) } },
      422,
    );

  it("puts the body's field names back on the form's fields", () => {
    expect(
      toContactFieldErrors(
        withFields([
          { field: "name", code: "too_small" },
          { field: "phone", code: "invalid_type" },
          { field: "email", code: "required" },
          { field: "legal_accepted", code: "invalid_literal" },
        ]),
      ),
    ).toEqual({
      name: "nameTooShort",
      phone: "required",
      email: "required",
      legalAccepted: "required",
    });
  });

  it("marks a rejected format on the field that carries it", () => {
    expect(
      toContactFieldErrors(
        withFields([
          { field: "phone", code: "invalid_format" },
          { field: "email", code: "invalid_format" },
        ]),
      ),
    ).toEqual({ phone: "phoneInvalid", email: "emailInvalid" });
  });

  it("drops errors about fields nobody can see, and keeps the first per field", () => {
    // An error anchored to `hold_token` would render as a summary line linking
    // to an input that does not exist.
    expect(
      toContactFieldErrors(
        withFields([
          { field: "hold_token", code: "too_small" },
          { field: "add_on_ids.0", code: "invalid_format" },
          { field: "name", code: "invalid_type" },
          { field: "name", code: "too_small" },
        ]),
      ),
    ).toEqual({ name: "required" });
  });
});

describe("public booking idempotency key", () => {
  const draft = {
    holdToken: "org.token",
    serviceId: "service-1",
    addOnIds: ["b", "a"],
    name: "Ирина",
    phone: "+37360123456",
    email: "irina@example.com",
    locale: "ru",
  };

  it("treats a resubmission of the same form as the same request", () => {
    expect(bookingRequestSignature(draft)).toBe(
      bookingRequestSignature({ ...draft, addOnIds: ["a", "b"] }),
    );
  });

  /**
   * The bug: the key was minted with the hold and kept, so correcting any field
   * sent the same key with a different payload and the API refused it as reuse
   * — for every attempt that followed, not just the first.
   */
  it.each([
    ["name", { name: "Ирина П." }],
    ["phone", { phone: "+37360123457" }],
    ["email", { email: "other@example.com" }],
    ["email cleared", { email: null }],
    ["locale", { locale: "ro" }],
    ["add-ons", { addOnIds: ["a"] }],
    ["service", { serviceId: "service-2" }],
    ["hold", { holdToken: "org.other" }],
  ])("earns a new key when the %s changes", (_label, change) => {
    expect(bookingRequestSignature({ ...draft, ...change })).not.toBe(
      bookingRequestSignature(draft),
    );
  });
});
