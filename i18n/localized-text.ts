import { supportedLocales, type AppLocale } from "@/i18n/messages";

/**
 * Business data that carries its own translations, as required by spec section
 * 11.2 for Service, ServiceCategory and AddOn. Every locale is optional: a user
 * who works only in Russian must not be forced to invent a Romanian name.
 */
export type LocalizedText = Partial<Record<AppLocale, string>>;

function usable(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * LOC-008 fallback: requested locale, then the organization's locale, then
 * English. Falls back to any remaining translation before giving up, because
 * showing a name in the wrong language beats showing an empty row.
 */
export function resolveLocalizedText(
  text: LocalizedText,
  requested: AppLocale,
  organizationLocale: AppLocale,
): string | null {
  for (const locale of [requested, organizationLocale, "en" as const]) {
    const value = text[locale];
    if (usable(value)) return value;
  }

  for (const locale of supportedLocales) {
    const value = text[locale];
    if (usable(value)) return value;
  }

  return null;
}

/** True when a translation is missing for the organization's own locale. */
export function isTranslationIncomplete(text: LocalizedText, organizationLocale: AppLocale) {
  return !usable(text[organizationLocale]);
}
