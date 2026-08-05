import type { AppLocale } from "@/i18n/messages";

/**
 * Translation lookup, spec LOC-001 through LOC-004.
 *
 * Gate 4 asks for "нет missing translation keys в критических flow". That is
 * enforced by the type system rather than by a runtime check: the Russian
 * dictionary defines the key set, and the other locales are typed as complete
 * records over it, so a forgotten key fails `tsc` instead of surfacing as a bare
 * `services.title` on a pilot's screen.
 */

/** A message is either fixed text or the plural forms of the locale. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | PluralForms;

export type Params = Record<string, string | number>;

/**
 * Plural rules come from `Intl`, so Russian's one/few/many, Romanian's
 * one/few/other and English's one/other are each selected by the locale's own
 * grammar. Hand-written modulo arithmetic gets Russian nearly right and
 * Romanian wrong.
 */
const pluralRules = new Map<AppLocale, Intl.PluralRules>();

function rulesFor(locale: AppLocale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

function resolve(message: Message, locale: AppLocale, params?: Params): string {
  if (typeof message === "string") return message;

  const count = typeof params?.count === "number" ? params.count : 0;
  const category = rulesFor(locale).select(count);
  return message[category] ?? message.other;
}

/** `{name}` and `{count}` are replaced; an unknown placeholder is left visible. */
function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

export function createTranslator<K extends string>(
  dictionaries: Record<AppLocale, Record<K, Message>>,
  locale: AppLocale,
) {
  const table = dictionaries[locale] ?? dictionaries.ru;

  return function t(key: K, params?: Params): string {
    // Keys are typed, so a missing one cannot normally happen. It can where a
    // key is built from a domain code — a costing reason, an import issue —
    // and the domain gains a new one before its wording is written. Showing
    // the code is a visible gap; the alternative here is a crash on the
    // dashboard, because an undefined message would be read as plural forms.
    const message = table[key] ?? dictionaries.ru[key];
    if (message === undefined) return key;
    return interpolate(resolve(message, locale, params), params);
  };
}

/**
 * BCP 47 tag for `Intl` and `<html lang>`. The region matters: `ru-MD` formats
 * money as `240,50 L` where `ru-RU` would write roubles.
 */
export function localeTag(locale: AppLocale): string {
  return locale === "en" ? "en-GB" : `${locale}-MD`;
}
