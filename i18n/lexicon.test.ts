import { describe, expect, it } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import { plainErrorWords, plainWords, soloErrorWords, soloWords, wordsFor, type Register } from "@/i18n/lexicon";
import { errorMessages, getErrorMessage, supportedLocales, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * The lexicon is a promise about whole screens — «соло-мастер не встречает
 * слово „комиссия“», «базовый режим говорит без финансового словаря» — kept by
 * a table rather than by call sites. So the table is read whole here: every
 * message a register can be shown is searched for the words it must not
 * contain, in all three languages, and the only exceptions are the keys that
 * register never draws, listed by name.
 */

const solo: Readonly<Record<AppLocale, RegExp>> = {
  ru: /комисси/i,
  ro: /comision/i,
  en: /commission/i,
};

const plain: Readonly<Record<AppLocale, RegExp>> = {
  ru: /комисси|вменён|вменен|маржинальн/i,
  ro: /comision|imputat|marj[aă] de contribuție/i,
  en: /commission|imputed|contribution margin/i,
};

/** Screens outside a workspace: the landing page and the document title. */
const outsideWorkspace = (key: string) => key.startsWith("landing.") || key.startsWith("app.");

/**
 * What the plain view leaves out (`app/app/reports/month/page.tsx`, the
 * service card, `app/app/settings/page.tsx`): the economist's lines and the
 * controls that feed them. Their words stay as written, for the detailed view.
 */
const notDrawnInPlainView = (key: string) =>
  key.startsWith("pl.principalAddBack.") ||
  key.startsWith("pl.principalHint.") ||
  key.startsWith("pl.ownerWage") ||
  key.startsWith("pl.economicProfit") ||
  key.startsWith("pl.safeToWithdraw") ||
  key.startsWith("labor.") ||
  [
    "services.fullyLoadedHint",
    "services.viewFullyLoaded",
    "capacity.rateHint",
    "capacity.profitPerPracticalHour",
    "capacity.practical",
    // `/app/how` names the detailed view's term only to whoever has it on.
    "how.leftDetailed",
  ].includes(key);

/** Messages only ever shown to somebody working alone. */
const soloOnly = (key: string) => key.endsWith(".solo") || key === "specialists.soloNoPrincipal";
/** And only ever to a studio — the other half of `businessLabel`. */
const studioOnly = (key: string) => key.endsWith(".studio");

function text(message: unknown): string {
  return typeof message === "string" ? message : JSON.stringify(message);
}

function offending(register: Register, patterns: Readonly<Record<AppLocale, RegExp>>, skip: (key: string) => boolean) {
  return supportedLocales.flatMap((locale) => {
    const table = { ...dictionaries[locale], ...wordsFor(register, locale) };
    return Object.entries(table)
      .filter(([key, message]) => !skip(key) && patterns[locale].test(text(message)))
      .map(([key]) => `${locale}/${key}`);
  });
}

describe("the lexicon", () => {
  it("never says «комиссия» to somebody working alone, in either view", () => {
    for (const detailed of [true, false]) {
      expect(
        offending({ business: "solo", detailed }, solo, (key) => outsideWorkspace(key) || studioOnly(key)),
      ).toEqual([]);
    }
  });

  it("says nothing from the finance dictionary in the plain view", () => {
    expect(
      offending(
        { business: "studio", detailed: false },
        plain,
        (key) => outsideWorkspace(key) || soloOnly(key) || notDrawnInPlainView(key),
      ),
    ).toEqual([]);
    expect(
      offending(
        { business: "solo", detailed: false },
        plain,
        (key) => outsideWorkspace(key) || studioOnly(key) || notDrawnInPlainView(key),
      ),
    ).toEqual([]);
  });

  it("replaces a message only with a different one, or it would not be here", () => {
    const pointless = [plainWords, soloWords].flatMap((layer) =>
      Object.entries(layer)
        .filter(([key, words]) =>
          supportedLocales.every(
            (locale) => text(words![locale]) === text(dictionaries[locale][key as keyof (typeof dictionaries)["ru"]]),
          ),
        )
        .map(([key]) => key),
    );
    expect(pointless).toEqual([]);
  });

  it("keeps every placeholder the dictionary's message had", () => {
    const lost = [plainWords, soloWords].flatMap((layer) =>
      Object.entries(layer).flatMap(([key, words]) =>
        supportedLocales
          .filter((locale) => {
            const placeholders = (message: unknown) => [...text(message).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
            const original = dictionaries[locale][key as keyof (typeof dictionaries)["ru"]];
            return placeholders(words![locale]).join() !== placeholders(original).join();
          })
          .map((locale) => `${locale}/${key}`),
      ),
    );
    expect(lost).toEqual([]);
  });

  it("leaves the dictionary as written for a studio with the detailed view", () => {
    expect(wordsFor({ business: "studio", detailed: true }, "ru")).toEqual({});
    expect(getTranslator("ru")("pl.contributionMargin")).toBe("Маржинальная прибыль");
    expect(getTranslator("ru", { business: "studio", detailed: true })("services.commission.studio")).toBe(
      "Комиссия мастера",
    );
  });

  it("speaks in three words in the plain view", () => {
    const t = getTranslator("ru", { business: "studio", detailed: false });
    expect(t("pl.contributionMargin")).toBe("Осталось");
    expect(t("pl.operatingProfit")).toBe("Осталось за месяц");
    expect(t("services.commission.studio")).toBe("Оплата мастеру");
    expect(getTranslator("ro", { business: "studio", detailed: false })("pl.operatingProfit")).toBe("Rămâne pe lună");
    expect(getTranslator("en", { business: "studio", detailed: false })("pl.contributionMargin")).toBe("Left");
  });

  it("puts the solo words over the plain ones, and keeps them in the detailed view", () => {
    expect(getTranslator("ru", { business: "solo", detailed: false })("specialists.commission")).toBe("Ставка за работу");
    expect(getTranslator("ru", { business: "solo", detailed: true })("specialists.commission")).toBe("Ставка за работу");
    // The detailed view keeps the economist's terms that are not «комиссия».
    expect(getTranslator("ru", { business: "solo", detailed: true })("pl.contributionMargin")).toBe(
      "Маржинальная прибыль",
    );
  });

  it("interpolates and pluralises a replaced message like any other", () => {
    const t = getTranslator("ru", { business: "solo", detailed: false });
    expect(t("specialists.withoutRuleBanner", { count: 2 })).toBe(
      "У 2 карточек не задана ставка за работу. Услуги нельзя посчитать, пока её нет, — можно поставить 0 %.",
    );
    expect(getTranslator("en", { business: "studio", detailed: false })("pl.operatingMargin", { rate: "12%" })).toBe(
      "That is 12% of revenue",
    );
  });

  describe("API errors", () => {
    it("words MISSING_COMMISSION_RULE for who reads it, in every language", () => {
      for (const locale of supportedLocales) {
        expect(getErrorMessage("MISSING_COMMISSION_RULE", "x", locale)).toBe(
          errorMessages[locale].MISSING_COMMISSION_RULE,
        );
        expect(
          getErrorMessage("MISSING_COMMISSION_RULE", "x", locale, { business: "solo", detailed: true }),
        ).not.toMatch(solo[locale]);
        expect(
          getErrorMessage("MISSING_COMMISSION_RULE", "x", locale, { business: "studio", detailed: false }),
        ).not.toMatch(plain[locale]);
      }
      expect(getErrorMessage("MISSING_COMMISSION_RULE", "x", "ru", { business: "solo", detailed: false })).toBe(
        soloErrorWords.MISSING_COMMISSION_RULE!.ru,
      );
      expect(getErrorMessage("MISSING_COMMISSION_RULE", "x", "ro", { business: "studio", detailed: false })).toBe(
        plainErrorWords.MISSING_COMMISSION_RULE!.ro,
      );
    });

    it("leaves every other code, and an unknown one, as it was", () => {
      expect(getErrorMessage("FORBIDDEN", "x", "ru", { business: "solo", detailed: false })).toBe(
        errorMessages.ru.FORBIDDEN,
      );
      expect(getErrorMessage("NO_SUCH_CODE", "fallback", "en", { business: "solo", detailed: false })).toBe("fallback");
    });

    it("has no code whose dictionary wording a register needs and does not replace", () => {
      for (const locale of supportedLocales) {
        const codes = Object.entries(errorMessages[locale])
          .filter(([, message]) => solo[locale].test(message))
          .map(([code]) => code);
        expect(codes.filter((code) => !soloErrorWords[code])).toEqual([]);
        expect(codes.filter((code) => !plainErrorWords[code])).toEqual([]);
      }
    });
  });
});
