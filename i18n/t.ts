import { dictionaries, type MessageKey } from "@/i18n/dictionary";
import type { AppLocale } from "@/i18n/messages";
import { createTranslator, type Params } from "@/i18n/translate";

export type { MessageKey };

/**
 * The one way the interface reads a string.
 *
 * Server components take the locale from the organization (LOC-008 puts the
 * organization's language first); client components receive it as a prop, so
 * the dictionary is chosen once on the server and never guessed in the browser.
 */
export type Translate = (key: MessageKey, params?: Params) => string;

export function getTranslator(locale: AppLocale): Translate {
  return createTranslator(dictionaries, locale);
}
