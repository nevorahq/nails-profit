/**
 * Public path segments for the booking page, roadmap sections 7.2 and 7.9.
 *
 * A slug is an address a client types and a receptionist reads over the phone,
 * so it is deliberately narrow: lowercase latin, digits and single hyphens.
 * Cyrillic is transliterated rather than percent-encoded — `/book/студия` in an
 * SMS becomes forty unreadable characters, and a salon cannot dictate that.
 *
 * Section 7.9 requires that the slug not reveal an internal id, which is why it
 * is never derived from one: a studio picks its own, and the reserved list
 * keeps it from colliding with a path the application already owns.
 */
const TRANSLITERATION: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
  // Romanian diacritics, which a Moldovan salon name is as likely to contain.
  ă: "a", â: "a", î: "i", ș: "s", ş: "s", ț: "t", ţ: "t",
};

/** Paths the application serves itself; a slug may never shadow one. */
export const RESERVED_SLUGS = new Set([
  "api",
  "app",
  "book",
  "booking",
  "admin",
  "login",
  "logout",
  "privacy",
  "terms",
  "static",
  "public",
  "_next",
  "health",
  "forgot-password",
  "reset-password",
]);

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;

/** Best-effort suggestion from a studio name; the result still has to validate. */
export function slugify(value: string): string {
  const lowered = value.trim().toLowerCase();
  let out = "";

  for (const character of lowered) {
    if (character in TRANSLITERATION) {
      out += TRANSLITERATION[character];
    } else if (/[a-z0-9]/.test(character)) {
      out += character;
    } else {
      out += "-";
    }
  }

  return out.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, SLUG_MAX_LENGTH).replace(/-$/, "");
}

export type SlugProblem = "too_short" | "too_long" | "invalid_characters" | "reserved";

export function checkSlug(value: string): SlugProblem | null {
  if (RESERVED_SLUGS.has(value)) return "reserved";
  if (value.length < SLUG_MIN_LENGTH) return "too_short";
  if (value.length > SLUG_MAX_LENGTH) return "too_long";
  // One expression, so the rule is readable: starts and ends with a letter or
  // digit, single hyphens inside.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return "invalid_characters";
  return null;
}

export function isValidSlug(value: string) {
  return checkSlug(value) === null;
}

/**
 * The base a generated address falls back to when the studio's name yields
 * nothing usable — «💅», «АБ», or a name made entirely of punctuation.
 *
 * A latin word rather than a random string: it is a URL a receptionist reads
 * over the phone, and `studio-2` can be dictated where `x7f2q` cannot.
 */
const GENERIC_BASE = "studio";

/**
 * The addresses a studio could be given for its name, in the order to try them.
 *
 * The studio is not asked for its address any more — it types a name once, on
 * the way in, and this is what that name becomes. So every candidate here has
 * to be usable without anybody reviewing it: `isValidSlug` is applied to each,
 * which is what silently drops «booking» (reserved) at the first attempt and
 * offers «booking-2» at the second.
 *
 * The suffix exists for collisions, and collisions are ordinary: two studios
 * called «Ногти» are two studios called «Ногти». Whoever registers second gets
 * `nogti-2` rather than an error about a name they cannot see.
 *
 * Pure, so the whole of it is testable — which address a studio ends up with is
 * decided by the caller, against the addresses already taken.
 */
export function slugCandidatesFor(name: string, howMany = 25): string[] {
  const transliterated = slugify(name);
  const base = transliterated.length >= SLUG_MIN_LENGTH ? transliterated : GENERIC_BASE;

  const candidates: string[] = [];
  for (let attempt = 1; candidates.length < howMany; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    // Room for the suffix, and never a trailing hyphen where the cut landed.
    const trimmed = base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, "");
    const candidate = `${trimmed}${suffix}`;
    if (isValidSlug(candidate)) candidates.push(candidate);
  }

  return candidates;
}
