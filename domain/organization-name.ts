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
