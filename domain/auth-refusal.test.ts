import { describe, expect, it } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";
import { authRefusal } from "./auth-refusal";

describe("authRefusal", () => {
  it("answers a rate-limited sign-in without a verdict on the address", () => {
    expect(authRefusal("signin", 429)).toBe("rate_limited");
  });

  /*
   * The regression this file exists for. A 429 used to fall into the sign-in
   * branch, so «you have been trying too fast» reached the reader as «you have
   * no account» — and the one thing that message tells somebody to do is
   * register a second account they do not need.
   */
  it("answers a rate-limited sign-up the same way, rather than in English", () => {
    expect(authRefusal("signup", 429)).toBe("rate_limited");
  });

  it("keeps a refused sign-in on the answer that names neither half", () => {
    expect(authRefusal("signin", 401)).toBe("no_match");
  });

  it("leaves a refused sign-up to the provider's own message", () => {
    expect(authRefusal("signup", 422)).toBe("provider");
  });
});

/*
 * The copy, in every language, because the defect was the sentence rather than
 * the branch: a message that answers «is there an account on this address?»
 * with «no» is wrong whenever the password was merely mistyped, and it reads as
 * the result of a lookup that never happened.
 */
describe("the refusal a sign-in shows", () => {
  const claimsTheAccountIsMissing = [
    "не найден",
    "нужна регистрация",
    "inexistent",
    "no account found",
  ];

  for (const locale of supportedLocales) {
    it(`does not claim the account is missing in ${locale}`, () => {
      const message = String(dictionaries[locale]["auth.signInNoMatch"]).toLowerCase();
      for (const claim of claimsTheAccountIsMissing) {
        expect(message).not.toContain(claim);
      }
    });

    it(`has something to say about the limiter in ${locale}`, () => {
      expect(String(dictionaries[locale]["auth.tooManyAttempts"])).not.toHaveLength(0);
    });
  }
});
