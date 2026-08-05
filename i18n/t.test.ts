import { describe, expect, it } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { supportedLocales } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";

const keys = Object.keys(dictionaries.ru) as MessageKey[];

describe("dictionaries", () => {
  it.each(supportedLocales)("%s defines every key", (locale) => {
    // Gate 4: "нет missing translation keys в критических flow". The type system
    // already refuses to compile a gap; this catches a key filled in with an
    // empty string, which types fine and reads as a blank button.
    const missing = keys.filter((key) => {
      const message = dictionaries[locale][key];
      return typeof message === "string" ? message.trim() === "" : message.other.trim() === "";
    });
    expect(missing).toEqual([]);
  });

  it.each(supportedLocales)("%s defines no key the source does not have", (locale) => {
    expect(Object.keys(dictionaries[locale]).sort()).toEqual([...keys].sort());
  });

  it.each(supportedLocales)("%s keeps every placeholder its message needs", (locale) => {
    // A translation that drops `{count}` silently renders "Импортировать строк".
    const broken: string[] = [];
    for (const key of keys) {
      const expected = placeholders(dictionaries.ru[key]);
      const actual = placeholders(dictionaries[locale][key]);
      if ([...expected].some((name) => !actual.has(name))) broken.push(key);
    }
    expect(broken).toEqual([]);
  });
});

function placeholders(message: string | { other: string }): Set<string> {
  const text = typeof message === "string" ? message : Object.values(message).join(" ");
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
}

describe("translation", () => {
  it("interpolates named parameters", () => {
    const t = getTranslator("ru");
    expect(t("import.columnNumber", { number: 3 })).toBe("колонка 3");
  });

  it("uses the Russian one/few/many forms", () => {
    const t = getTranslator("ru");
    expect(t("import.confirm", { count: 1 })).toBe("Импортировать 1 строку");
    expect(t("import.confirm", { count: 2 })).toBe("Импортировать 2 строки");
    expect(t("import.confirm", { count: 5 })).toBe("Импортировать 5 строк");
    expect(t("import.confirm", { count: 21 })).toBe("Импортировать 21 строку");
  });

  it("uses the Romanian forms, which differ from the Russian ones", () => {
    // Romanian puts 20+ into a separate form with "de"; a rule copied from
    // Russian would write "21 rânduri".
    const t = getTranslator("ro");
    expect(t("import.confirm", { count: 1 })).toBe("Importă 1 rând");
    expect(t("import.confirm", { count: 2 })).toBe("Importă 2 rânduri");
    expect(t("import.confirm", { count: 21 })).toBe("Importă 21 de rânduri");
  });

  it("uses the English one/other split", () => {
    const t = getTranslator("en");
    expect(t("import.confirm", { count: 1 })).toBe("Import 1 row");
    expect(t("import.confirm", { count: 2 })).toBe("Import 2 rows");
  });

  it("shows the key when the domain grows a code the dictionary lacks", () => {
    // A new costing reason must not crash the dashboard: an undefined message
    // would be read as plural forms and dereferenced.
    const t = getTranslator("ru");
    expect(t("reason.brand_new_code" as MessageKey)).toBe("reason.brand_new_code");
  });

  it("leaves an unknown placeholder visible rather than blank", () => {
    const t = getTranslator("ru");
    expect(t("import.columnNumber")).toContain("{number}");
  });
});

describe("localeTag", () => {
  it("keeps the Moldovan region, which decides how money reads", () => {
    // ru-RU would format MDL against Russian conventions; ru-MD is the pilot.
    expect(localeTag("ru")).toBe("ru-MD");
    expect(localeTag("ro")).toBe("ro-MD");
    expect(localeTag("en")).toBe("en-GB");
  });
});
