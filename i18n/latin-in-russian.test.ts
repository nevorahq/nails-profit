import { describe, expect, it } from "vitest";

import { dictionaries } from "@/i18n/dictionary";

/**
 * Latin letters in a Russian string are either a name nobody translates or a
 * word somebody forgot to — «Owner», «Marketing», «production-запуск». The
 * names are listed; anything else fails, so a new English word has to be
 * argued for here rather than slipping into the screen.
 */
const allowed = new Set([
  // Messengers, providers and products
  "WhatsApp", "Telegram", "Viber", "Paddle", "Lemon", "Squeezy", "Nail", "Profit", "Maib",
  // Browsers and devices
  "Chrome", "Safari", "Firefox", "iPhone", "Android", "Windows", "Excel",
  // Formats and protocols
  "CSV", "JPEG", "PNG", "WebP", "JSON", "UTF", "vcf", "API", "Email", "email", "cookie", "Cookie",
  // Examples inside placeholders
  "Studio", "Belle", "irina", "example", "com",
]);

function strings(message: string | Record<string, string | undefined>) {
  return typeof message === "string" ? [message] : Object.values(message).filter((value): value is string => !!value);
}

describe("Russian dictionary", () => {
  it("contains Latin words only from the allow-list", () => {
    const stray: string[] = [];
    for (const [key, message] of Object.entries(dictionaries.ru)) {
      for (const text of strings(message)) {
        const words = text.replace(/\{\w+\}/g, "").match(/[A-Za-z]+/g) ?? [];
        const unknown = words.filter((word) => !allowed.has(word));
        if (unknown.length > 0) stray.push(`${key}: ${unknown.join(", ")}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("keeps «Owner» and «PII» out of Romanian too, where the word is not Romanian either", () => {
    const stray = Object.entries(dictionaries.ro).flatMap(([key, message]) =>
      strings(message).some((text) => /\b(Owner|PII)\b/.test(text)) ? [key] : [],
    );
    expect(stray).toEqual([]);
  });
});
