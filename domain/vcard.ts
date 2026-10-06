import { clientTemplate } from "@/domain/import-templates";
import { normalizePhone } from "@/domain/phone";

/**
 * Contacts exported from a phone (.vcf), read into the client list.
 *
 * vCard 3.0 is what iPhone and Google Contacts write, 4.0 what newer Android
 * builds do; Samsung's own export is still 2.1 with quoted-printable Cyrillic,
 * and is read too, because a list of mojibake where the names should be would
 * make the whole feature look broken to the owner it is for.
 *
 * Nothing here throws on a bad line. A phone book is years of other apps'
 * writes, and one card a sync tool mangled must not cost the owner the other
 * four hundred — a line that cannot be read is skipped, a card without END is
 * closed by the next BEGIN.
 *
 * Pure and dependency-free so the browser can show the list before anything is
 * uploaded, and the server can read the same file the same way: the selection
 * travels as positions in this function's output.
 */

export type VCardContact = Readonly<{
  /** Position among the contacts read, which is how a selection names it. */
  index: number;
  name: string;
  /** E.164 of the number chosen for the card, or null when none could be read. */
  phone: string | null;
  /**
   * The number as written when the card has one but none of its numbers could
   * be read — kept so the list can say why this contact arrives without one.
   */
  unreadablePhone: string | null;
  email: string | null;
}>;

type Property = Readonly<{
  name: string;
  params: ReadonlyMap<string, readonly string[]>;
  /** Bare 2.1 parameters such as `CELL` in `TEL;CELL:`, folded into TYPE. */
  types: ReadonlySet<string>;
  value: string;
}>;

type Phone = Readonly<{ raw: string; preferred: boolean; mobile: boolean }>;

export function parseVCards(text: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  let card: Property[] | null = null;

  const close = () => {
    if (card === null) return;
    const contact = toContact(card, contacts.length);
    if (contact) contacts.push(contact);
    card = null;
  };

  for (const line of unfold(text)) {
    const property = parseLine(line);
    if (property === null) continue;

    if (property.name === "BEGIN" && property.value.trim().toUpperCase() === "VCARD") {
      close();
      card = [];
    } else if (property.name === "END" && property.value.trim().toUpperCase() === "VCARD") {
      close();
    } else if (card !== null) {
      card.push(property);
    }
  }
  close();

  return contacts;
}

/** True when the file is a vCard, whatever its name or the type the phone gave it. */
export function looksLikeVCard(text: string): boolean {
  return /^\s*BEGIN:VCARD\s*$/im.test(text.slice(0, 1024));
}

/**
 * Joins folded lines back into one.
 *
 * A line beginning with a space or a tab continues the previous one, minus
 * that one character (RFC 6350 §3.2). Quoted-printable values in 2.1 fold the
 * other way — a trailing `=` says the next line belongs to this one, with no
 * leading space — and both conventions turn up in the same Android export.
 */
function unfold(text: string): string[] {
  const lines: string[] = [];
  let softBreak = false;

  for (const physical of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const last = lines.length - 1;
    if (softBreak && last >= 0) {
      lines[last] = lines[last].slice(0, -1) + physical;
    } else if ((physical.startsWith(" ") || physical.startsWith("\t")) && last >= 0) {
      lines[last] += physical.slice(1);
    } else {
      lines.push(physical);
    }
    const current = lines[lines.length - 1] ?? "";
    softBreak = /QUOTED-PRINTABLE/i.test(current.split(":", 1)[0] ?? "") && current.endsWith("=");
  }

  return lines;
}

/**
 * `[group.]NAME[;param...]:value`. The first colon outside a quoted parameter
 * value ends the name part — `TEL;TYPE="cell,voice":+373…` has its quotes for
 * exactly that reason. A line with no colon is not a property; null.
 */
function parseLine(line: string): Property | null {
  let quoted = false;
  let colon = -1;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      colon = at;
      break;
    }
  }
  if (colon <= 0) return null;

  const [head, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
  const name = head.slice(head.lastIndexOf(".") + 1).trim().toUpperCase();
  if (name === "") return null;

  const params = new Map<string, string[]>();
  const types = new Set<string>();
  for (const raw of rawParams) {
    const equals = raw.indexOf("=");
    if (equals === -1) {
      if (raw.trim() !== "") types.add(raw.trim().toLowerCase());
      continue;
    }
    const key = raw.slice(0, equals).trim().toUpperCase();
    const values = splitOutsideQuotes(raw.slice(equals + 1), ",").map((value) =>
      value.trim().replace(/^"|"$/g, ""),
    );
    params.set(key, [...(params.get(key) ?? []), ...values]);
    if (key === "TYPE") for (const value of values) types.add(value.toLowerCase());
  }

  let value = line.slice(colon + 1);
  const encoding = params.get("ENCODING")?.[0]?.toUpperCase();
  if (encoding === "QUOTED-PRINTABLE") value = decodeQuotedPrintable(value, params.get("CHARSET")?.[0]);

  return { name, params, types, value };
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** `=D0=9C=D0=B0` is bytes, not characters: decoded together, then as text. */
function decodeQuotedPrintable(value: string, charset = "utf-8"): string {
  const bytes: number[] = [];
  for (let at = 0; at < value.length; at += 1) {
    const hex = value.slice(at + 1, at + 3);
    if (value[at] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      at += 2;
    } else {
      bytes.push(...new TextEncoder().encode(value[at]));
    }
  }
  try {
    return new TextDecoder(charset.toLowerCase()).decode(new Uint8Array(bytes));
  } catch {
    // An unknown CHARSET label: UTF-8 is what every phone actually writes.
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

/**
 * Splits a structured value on its unescaped separators, then unescapes each
 * part. In that order: `\;` is a semicolon inside a part, not a boundary.
 */
function components(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let at = 0; at < value.length; at += 1) {
    if (value[at] === "\\" && at + 1 < value.length) {
      current += value[at] + value[at + 1];
      at += 1;
    } else if (value[at] === ";") {
      parts.push(current);
      current = "";
    } else {
      current += value[at];
    }
  }
  parts.push(current);
  return parts.map(unescapeText);
}

/** A newline inside a name is a line break the phone kept, read here as a space. */
function unescapeText(value: string): string {
  return value
    .replace(/\\([nN,;:\\])/g, (_, char: string) => (char === "n" || char === "N" ? " " : char))
    .replace(/\s+/g, " ")
    .trim();
}

function toContact(properties: readonly Property[], index: number): VCardContact | null {
  const first = (name: string) => properties.find((property) => property.name === name);

  const phones: Phone[] = properties
    .filter((property) => property.name === "TEL")
    .map((property) => ({
      // 4.0 may write the number as a URI: `tel:+373-69-123-456;ext=2`.
      raw: unescapeText(property.value).replace(/^tel:/i, "").replace(/;.*$/, "").trim(),
      preferred: property.types.has("pref") || property.params.has("PREF"),
      mobile: property.types.has("cell") || property.types.has("mobile") || property.types.has("iphone"),
    }))
    .filter((phone) => phone.raw !== "");

  // Preferred first, then mobile, then the order the card lists them: the
  // number a studio texts a reminder to is the mobile, and a landline at the
  // top of the card is the common way that goes wrong.
  const ranked = phones
    .map((phone, at) => ({ phone, at }))
    .sort(
      (a, b) =>
        Number(b.phone.preferred) - Number(a.phone.preferred) ||
        Number(b.phone.mobile) - Number(a.phone.mobile) ||
        a.at - b.at,
    )
    .map(({ phone }) => phone);

  const readable = ranked.map((phone) => normalizePhone(phone.raw)).find((phone) => phone !== null) ?? null;

  const emails = properties
    .filter((property) => property.name === "EMAIL")
    .map((property) => ({ value: unescapeText(property.value), preferred: property.types.has("pref") || property.params.has("PREF") }))
    .filter((email) => email.value.includes("@"));
  const email = (emails.find((item) => item.preferred) ?? emails[0])?.value ?? null;

  const name =
    unescapeText(first("FN")?.value ?? "") ||
    nameFromParts(first("N")?.value) ||
    components(first("ORG")?.value ?? "")[0] ||
    ranked[0]?.raw ||
    email ||
    "";

  if (name === "") return null;

  return {
    index,
    name,
    phone: readable,
    unreadablePhone: readable === null ? (ranked[0]?.raw ?? null) : null,
    email,
  };
}

/** `N:Family;Given;Additional;Prefix;Suffix`, said the way a person is addressed. */
function nameFromParts(value: string | undefined): string {
  if (value === undefined) return "";
  const [family = "", given = "", additional = "", prefix = "", suffix = ""] = components(value);
  return [prefix, given, additional, family, suffix].filter((part) => part !== "").join(" ");
}

/**
 * The contacts as the client file the import already reads.
 *
 * Its headers are the client template's own labels, so the mapping step finds
 * every column by name and the owner has nothing to match. Every cell is
 * quoted rather than formula-guarded: this text is never opened in Excel, and
 * an apostrophe added in front of `=Ира` would become part of her name.
 */
export function contactsToCsv(contacts: readonly VCardContact[]): string {
  const cell = (value: string | null) => `"${(value ?? "").replaceAll('"', '""')}"`;
  const label = (key: string) => clientTemplate.fields.find((field) => field.key === key)?.label ?? key;
  const rows = [
    [label("name"), label("phone"), label("email")].map(cell).join(","),
    ...contacts.map((contact) => [contact.name, contact.phone, contact.email].map(cell).join(",")),
  ];
  return `${rows.join("\n")}\n`;
}
