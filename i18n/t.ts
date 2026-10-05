import { dictionaries, type MessageKey } from "@/i18n/dictionary";
import { wordsFor, writtenRegister, type Register } from "@/i18n/lexicon";
import type { AppLocale } from "@/i18n/messages";
import { createTranslator, type Message, type Params } from "@/i18n/translate";

export type { MessageKey };

/**
 * The one way the interface reads a string.
 *
 * Server components take the locale from the organization (LOC-008 puts the
 * organization's language first); client components receive it as a prop, so
 * the dictionary is chosen once on the server and never guessed in the browser.
 */
export type Translate = (key: MessageKey, params?: Params) => string;

type Dictionaries = Record<AppLocale, Record<MessageKey, Message>>;

/** One merged set per register and language, built once: twelve at most. */
const reworded = new Map<string, Dictionaries>();

function dictionariesFor(register: Register, locale: AppLocale): Dictionaries {
  const words = wordsFor(register, locale);
  if (Object.keys(words).length === 0) return dictionaries;

  const id = `${register.business}:${register.detailed}:${locale}`;
  let merged = reworded.get(id);
  if (!merged) {
    merged = { ...dictionaries, [locale]: { ...dictionaries[locale], ...words } };
    reworded.set(id, merged);
  }
  return merged;
}

/**
 * The register is who is reading: somebody working alone or a studio, and
 * whether the owner asked for detailed analytics. Absent means the dictionary
 * as written — what every screen outside a workspace reads. Inside one, server
 * pages pass `registerOf(workspace)` and client components read it through
 * `useTranslator` — see `i18n/lexicon.ts`.
 */
export function getTranslator(locale: AppLocale, register: Register = writtenRegister): Translate {
  return createTranslator(dictionariesFor(register, locale), locale);
}
