/**
 * CSV reading for the import flow, spec INT-001 and INT-002.
 *
 * The files this has to survive come out of Excel on a Moldovan laptop, so the
 * defaults of any given parser are wrong about half the time: the separator is
 * `;` as often as `,`, the encoding is Windows-1251 as often as UTF-8, and the
 * first byte is frequently a BOM. Guessing wrong is not a subtle failure — the
 * whole file collapses into a single column, or every Cyrillic name turns to
 * mojibake, and the owner concludes the product does not work.
 */

export const csvDelimiters = [",", ";", "\t"] as const;
export type CsvDelimiter = (typeof csvDelimiters)[number];

export type CsvRow = Readonly<{
  /**
   * 1-based line in the source file, counting the header and any blank lines.
   * Errors are reported with this number so that "строка 42" means line 42 in
   * the file the owner still has open in Excel.
   */
  line: number;
  cells: readonly string[];
}>;

export type ParsedCsv = Readonly<{
  headers: readonly string[];
  rows: readonly CsvRow[];
  delimiter: CsvDelimiter;
  encoding: CsvEncoding;
}>;

export type CsvEncoding = "utf-8" | "windows-1251";

const BOM_UTF8 = [0xef, 0xbb, 0xbf];

/**
 * Decodes a file, choosing between UTF-8 and Windows-1251.
 *
 * A UTF-8 BOM settles it. Otherwise we decode strictly as UTF-8 and fall back
 * to Windows-1251 when that throws: Cyrillic text in Windows-1251 is almost
 * always invalid UTF-8, while text that is valid UTF-8 is virtually never
 * meant to be Windows-1251. Getting this backwards is what produces "Ìàíèêþð".
 */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  const hasBom = BOM_UTF8.every((byte, index) => bytes[index] === byte);
  const body = hasBom ? bytes.subarray(BOM_UTF8.length) : bytes;

  if (hasBom) return { text: new TextDecoder("utf-8").decode(body), encoding: "utf-8" };

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1251").decode(body), encoding: "windows-1251" };
  }
}

/**
 * Picks the delimiter by parsing the file once per candidate and taking the one
 * that yields the most columns in the header.
 *
 * Counting raw characters would be fooled by the common case of a semicolon
 * file whose first column is `"Маникюр, классический"` — the comma inside the
 * quotes would win. Parsing respects the quotes, so it cannot.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let best: CsvDelimiter = ",";
  let bestColumns = 0;

  for (const candidate of csvDelimiters) {
    const [header] = readRecords(text, candidate, 1);
    const columns = header?.cells.length ?? 0;
    if (columns > bestColumns) {
      best = candidate;
      bestColumns = columns;
    }
  }

  return best;
}

export function parseCsv(input: Uint8Array | string, delimiter?: CsvDelimiter): ParsedCsv {
  const decoded =
    typeof input === "string" ? { text: stripBom(input), encoding: "utf-8" as const } : decodeCsv(input);
  const separator = delimiter ?? detectDelimiter(decoded.text);
  const records = readRecords(decoded.text, separator);

  const [header, ...rest] = records;

  return {
    headers: (header?.cells ?? []).map(normalizeHeader),
    // A row of nothing but empty cells is a trailing newline or a blank line
    // Excel left behind, not a row the owner has to fix.
    rows: rest.filter((row) => row.cells.some((cell) => cell.trim() !== "")),
    delimiter: separator,
    encoding: decoded.encoding,
  };
}

/** Header keys are matched case- and space-insensitively; the BOM is stripped. */
export function normalizeHeader(header: string): string {
  return stripBom(header).trim().toLowerCase().replace(/\s+/g, " ");
}

function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/**
 * RFC 4180 with the tolerances real files need: bare CR, CRLF and LF endings,
 * and quotes that appear mid-field.
 *
 * `limit` stops early — `detectDelimiter` only needs the first record, and a
 * 20 MB file should not be parsed three times in full to find the separator.
 */
function readRecords(text: string, delimiter: CsvDelimiter, limit = Infinity): CsvRow[] {
  const records: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  /** Physical line being read; a quoted field may span several. */
  let line = 1;
  /** Physical line the record in progress started on. */
  let recordStart = 1;

  const endField = () => {
    cells.push(field);
    field = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }

    // A quote only opens a quoted field at the very start of that field.
    // Anywhere else it is literal text: `Гель 5" стойкий` is a name, and
    // treating its quote as an opening delimiter would swallow the rest of the
    // line. Excel and every tolerant parser read it the same way.
    if (char === '"' && field === "") {
      quoted = true;
      continue;
    }

    if (char === delimiter) {
      endField();
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endField();
      records.push({ line: recordStart, cells });
      cells = [];
      line += 1;
      recordStart = line;
      if (records.length >= limit) return records;
      continue;
    }

    field += char;
  }

  // A file that does not end with a newline still has a last record.
  if (field !== "" || cells.length > 0) {
    records.push({ line: recordStart, cells: [...cells, field] });
  }

  return records;
}
