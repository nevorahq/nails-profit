import { describe, expect, it } from "vitest";

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
