import { describe, expect, it } from "vitest";

import { isTranslationIncomplete, resolveLocalizedText } from "@/i18n/localized-text";

describe("resolveLocalizedText", () => {
  it("prefers the requested locale", () => {
    expect(resolveLocalizedText({ ru: "Маникюр", ro: "Manichiură" }, "ro", "ru")).toBe("Manichiură");
  });

  it("falls back to the organization locale before English", () => {
    expect(resolveLocalizedText({ ru: "Маникюр", en: "Manicure" }, "ro", "ru")).toBe("Маникюр");
  });

  it("falls back to English when the organization locale is missing too", () => {
    expect(resolveLocalizedText({ en: "Manicure" }, "ro", "ru")).toBe("Manicure");
  });

  it("uses any remaining translation rather than rendering an empty name", () => {
    expect(resolveLocalizedText({ ro: "Manichiură" }, "en", "en")).toBe("Manichiură");
  });

  it("treats blank strings as missing", () => {
    expect(resolveLocalizedText({ ro: "   ", ru: "Маникюр" }, "ro", "ru")).toBe("Маникюр");
  });

  it("returns null when nothing is translated", () => {
    expect(resolveLocalizedText({}, "ru", "ru")).toBeNull();
  });
});

describe("isTranslationIncomplete", () => {
  it("flags a missing translation for the organization locale", () => {
    expect(isTranslationIncomplete({ en: "Manicure" }, "ru")).toBe(true);
    expect(isTranslationIncomplete({ ru: "Маникюр" }, "ru")).toBe(false);
    expect(isTranslationIncomplete({ ru: "  " }, "ru")).toBe(true);
  });
});
