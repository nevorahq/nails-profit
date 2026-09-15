import type { AppLocale } from "@/i18n/messages";

/**
 * Endonyms, deliberately untranslated: someone looking for their own language
 * scans for the word they would write themselves, and a Romanian speaker
 * stranded in a Russian interface is looking for "Română", not "Румынский".
 *
 * Shared by the two pickers that offer the language — the one on the setup
 * screen, where the choice is made, and the one in Настройки, where it is
 * changed — so the two cannot come to spell a language differently.
 */
export const localeNames: Record<AppLocale, string> = {
  ru: "Русский",
  ro: "Română",
  en: "English",
};
