import { describe, expect, it } from "vitest";

import { localeFromHeader } from "@/i18n/accept-language";

describe("localeFromHeader", () => {
  it("reads a plain tag", () => {
    expect(localeFromHeader("ro")).toBe("ro");
  });

  it("ignores the region", () => {
    expect(localeFromHeader("ro-MD")).toBe("ro");
    expect(localeFromHeader("en-US,en;q=0.9")).toBe("en");
  });

  it("respects quality values rather than document order", () => {
    // `ro;q=0.9, ru;q=1.0` states a preference for Russian. Taking the first
    // tag would invert it and greet the visitor in the wrong language.
    expect(localeFromHeader("ro;q=0.9, ru;q=1.0")).toBe("ru");
    expect(localeFromHeader("ru;q=0.2, ro;q=0.8")).toBe("ro");
  });

  it("skips languages the product does not have", () => {
    expect(localeFromHeader("de-DE,de;q=0.9,ro;q=0.5")).toBe("ro");
  });

  it("falls back to Russian, the pilot's language", () => {
    expect(localeFromHeader(null)).toBe("ru");
    expect(localeFromHeader("de,fr")).toBe("ru");
    expect(localeFromHeader("")).toBe("ru");
  });
});
