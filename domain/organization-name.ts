import { TRANSLITERATION } from "@/domain/slug";

/**
 * What a studio may call itself.
 *
 * Latin script only — the decision is a naming one, not a technical limit:
 * `domain/slug.ts` transliterates Cyrillic perfectly well, and «Студия» would
 * reach the public booking page as `/book/studiya`. The rule exists so that the
 * name a client sees on a booking link, an invitation and an email reads in one
 * alphabet.
 *
 * Enforced here rather than only in the form, because the form is not the only
 * door: `POST /api/v1/organizations` creates a studio and the settings endpoint
 * renames one, and both are reachable without a browser.
 *
 * Romanian diacritics are inside the rule, not an exception to it — the pilot
 * is in Moldova, and «Frumusețe» is a Latin name. Digits, spaces and the
 * punctuation that appears in real studio names are allowed; everything else,
 * Cyrillic included, is not.
 */
export const ORGANIZATION_NAME_PATTERN = /^[A-Za-zĂÂÎȘȚăâîșț0-9 &'’.\-]+$/u;

export function isLatinOrganizationName(value: string): boolean {
  return ORGANIZATION_NAME_PATTERN.test(value.trim());
}

/** The message a refusal carries, in the API's own English. */
export const ORGANIZATION_NAME_MESSAGE =
  "The studio name must be written in Latin letters, digits, spaces or - . & '";

/**
 * A name written in any alphabet, turned into one this rule accepts.
 *
 * The setup form does not ask for a studio name any more — the account has just
 * been created under somebody's own name, and typing «Irina Popescu» twice in
 * two minutes is a question the product can answer for itself. But it has to
 * answer it in Latin: the account's name is whatever the owner writes, usually
 * Cyrillic in the pilot, and the rule above is about what a client reads on a
 * booking link.
 *
 * The same table the address uses, so a studio and its `/book/...` cannot
 * disagree about what the letters are. Case is kept — «Ирина» becomes «Irina»
 * and not «irina» — because this is a name on a page, not a URL.
 *
 * Null when nothing usable is left: an account named with emoji, or in a script
 * the table does not know. The caller then falls back to something it can
 * guarantee rather than registering a studio called «--».
 */
export function latinizeOrganizationName(value: string): string | null {
  let out = "";
  for (const character of value.trim()) {
    if (ORGANIZATION_NAME_PATTERN.test(character)) {
      out += character;
      continue;
    }

    const lowered = character.toLocaleLowerCase();
    const replacement = TRANSLITERATION[lowered];
    if (replacement === undefined) {
      // A space, not nothing: «Ирина·Попеску» written with an unknown
      // separator must not become one word.
      out += " ";
      continue;
    }

    out +=
      character === lowered
        ? replacement
        : replacement.charAt(0).toLocaleUpperCase() + replacement.slice(1);
  }

  const collapsed = out.replace(/\s+/g, " ").trim().slice(0, 100).trim();
  return collapsed.length >= 2 && isLatinOrganizationName(collapsed) ? collapsed : null;
}
