import type { CsvRow } from "@/domain/csv";
import { normalizeHeader } from "@/domain/csv";
import { looksLikeFormula } from "@/domain/csv-safety";
import { rowIdentity, type ImportEntity } from "@/domain/import-identity";
import {
  parseBoolean,
  parseDurationMinutes,
  parseIntegerValue,
  parseLocalDate,
  parseMilliUnits,
  parseMoneyMinor,
  parsePercentBasisPoints,
} from "@/domain/import-values";
import { normalizePhone } from "@/domain/phone";

/**
 * Column mapping and row validation, spec INT-002 and INT-005.
 *
 * Two rules shape this file. First, validation reports every problem in a row
 * rather than stopping at the first: an owner fixing a price list wants one
 * pass through the file, not one round trip per cell. Second, a bad row never
 * takes a good one down with it — the result is created/updated/skipped/failed,
 * not all-or-nothing, because a 300-row file with two typos is otherwise
 * unusable.
 */

export type FieldType =
  | "text"
  | "money"
  | "quantity"
  | "integer"
  | "duration"
  | "percent"
  | "date"
  | "boolean"
  | "phone"
  | "enum";

export type ImportField = Readonly<{
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Header names matched automatically, normalized the same way headers are. */
  aliases: readonly string[];
  options?: readonly string[];
  hint?: string;
}>;

export type ImportTemplate = Readonly<{
  entity: ImportEntity;
  label: string;
  fields: readonly ImportField[];
  /** Field keys whose values form the dedup fingerprint when no id is given. */
  naturalKey: readonly string[];
}>;

export type CellValue = string | number | boolean | Date | null;

export type IssueCode =
  | "required_missing"
  | "not_a_number"
  | "not_a_date"
  | "not_a_duration"
  | "not_a_boolean"
  | "not_a_phone"
  | "not_an_option"
  | "negative_not_allowed"
  | "too_long"
  | "duplicate_in_file"
  | "looks_like_formula"
  /** Raised while writing, not while validating — a constraint the file broke. */
  | "write_failed";

export type RowIssue = Readonly<{
  line: number;
  field: string;
  code: IssueCode;
  /** The cell as written, so the preview can show what to look for in Excel. */
  value: string;
}>;

export type MappedRow = Readonly<{
  line: number;
  externalId: string;
  identityKind: "external" | "fingerprint";
  values: Readonly<Record<string, CellValue>>;
  raw: Readonly<Record<string, string>>;
  warnings: readonly RowIssue[];
}>;

export type ImportPreview = Readonly<{
  /** Required fields with no column; nothing can be imported until they are mapped. */
  missingRequiredFields: readonly string[];
  rows: readonly MappedRow[];
  failed: readonly Readonly<{ line: number; issues: readonly RowIssue[] }>[];
  skipped: readonly Readonly<{ line: number; issues: readonly RowIssue[] }>[];
  warnings: readonly RowIssue[];
}>;

/** Field key -> column index in the file, or null when unmapped. */
export type ColumnMapping = Readonly<Record<string, number | null>>;

const MAX_TEXT_LENGTH = 200;

/**
 * Guesses the mapping from the file's headers.
 *
 * Three passes, strongest evidence first, each completed for every field before
 * the next begins. The order is what stops a loose alias from stealing a
 * column: `цена` is an alias of the package price, so in a file with both
 * `Цена упаковки` and `Цена` a single pass would hand the field whichever
 * column came first rather than the one that names it.
 *
 * Pass one is the field's own name and label — the label matters because it is
 * the header our downloadable template writes, so a file the owner got from us
 * and filled in has to map back without a single manual correction.
 */
export function suggestMapping(
  template: ImportTemplate,
  headers: readonly string[],
): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const mapping: Record<string, number | null> = {};
  const taken = new Set<number>();

  for (const field of template.fields) mapping[field.key] = null;

  const claim = (fieldKey: string, index: number) => {
    mapping[fieldKey] = index;
    taken.add(index);
  };

  const pass = (candidatesFor: (field: ImportField) => string[], match: (header: string, candidate: string) => boolean) => {
    for (const field of template.fields) {
      if (mapping[field.key] !== null) continue;
      const candidates = candidatesFor(field);
      const index = normalized.findIndex(
        (header, at) =>
          !taken.has(at) && header !== "" && candidates.some((candidate) => match(header, candidate)),
      );
      if (index !== -1) claim(field.key, index);
    }
  };

  const exact = (header: string, candidate: string) => header === candidate;
  const contains = (header: string, candidate: string) => header.includes(candidate);

  pass((field) => [normalizeHeader(field.key), normalizeHeader(field.label)], exact);
  pass((field) => field.aliases.map(normalizeHeader), exact);
  pass(
    (field) => [normalizeHeader(field.label), ...field.aliases.map(normalizeHeader)],
    contains,
  );

  return mapping;
}

export function buildPreview(
  template: ImportTemplate,
  mapping: ColumnMapping,
  rows: readonly CsvRow[],
): ImportPreview {
  const missingRequiredFields = template.fields
    .filter((field) => field.required && mapping[field.key] == null)
    .map((field) => field.key);

  if (missingRequiredFields.length > 0) {
    return { missingRequiredFields, rows: [], failed: [], skipped: [], warnings: [] };
  }

  const accepted: MappedRow[] = [];
  const failed: { line: number; issues: RowIssue[] }[] = [];
  const skipped: { line: number; issues: RowIssue[] }[] = [];
  const warnings: RowIssue[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    const { values, raw, issues, rowWarnings } = validateRow(template, mapping, row);

    if (issues.length > 0) {
      failed.push({ line: row.line, issues });
      continue;
    }

    const identity = rowIdentity(
      template.entity,
      raw.external_id ?? null,
      // Built from the parsed values, not the source text. A phone written
      // `069 123 456` in one export and `+37369123456` in the next is one
      // subscriber, and INT-003 asks for a fingerprint that is stable across
      // exactly that kind of reformatting.
      template.naturalKey.map((key) => canonicalKeyPart(values[key] ?? null)),
    );

    const firstSeenAt = seen.get(identity.externalId);
    if (firstSeenAt !== undefined) {
      // The same row twice in one file. Keeping the first is the predictable
      // reading, and the owner is told which line was dropped rather than
      // discovering later that one of the two silently won.
      skipped.push({
        line: row.line,
        issues: [
          {
            line: row.line,
            field: template.naturalKey[0] ?? "",
            code: "duplicate_in_file",
            value: `строка ${firstSeenAt}`,
          },
        ],
      });
      continue;
    }

    seen.set(identity.externalId, row.line);
    warnings.push(...rowWarnings);
    accepted.push({
      line: row.line,
      externalId: identity.externalId,
      identityKind: identity.kind,
      values,
      raw,
      warnings: rowWarnings,
    });
  }

  return { missingRequiredFields: [], rows: accepted, failed, skipped, warnings };
}

/** One canonical string per parsed value, so the fingerprint is reproducible. */
function canonicalKeyPart(value: CellValue): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function validateRow(template: ImportTemplate, mapping: ColumnMapping, row: CsvRow) {
  const values: Record<string, CellValue> = {};
  const raw: Record<string, string> = {};
  const issues: RowIssue[] = [];
  const rowWarnings: RowIssue[] = [];

  for (const field of template.fields) {
    const column = mapping[field.key];
    // Excel drops trailing empty cells, so a short row is normal, not corrupt.
    const cell = column == null ? "" : (row.cells[column] ?? "");
    const text = cell.trim();
    raw[field.key] = text;

    const issue = (code: IssueCode): RowIssue => ({ line: row.line, field: field.key, code, value: cell });

    if (text === "") {
      if (field.required) issues.push(issue("required_missing"));
      values[field.key] = null;
      continue;
    }

    // Recorded, not rejected: the value is stored as text and is harmless until
    // it is written back into a CSV, which `toCsv` neutralizes. The owner still
    // gets told, because a name like `=1+1` is nearly always a broken export
    // rather than an attack, and either way they want to know.
    if (looksLikeFormula(text)) rowWarnings.push(issue("looks_like_formula"));

    const parsed = parseCell(field, text);
    if (parsed.ok) {
      values[field.key] = parsed.value;
    } else {
      issues.push(issue(parsed.code));
      values[field.key] = null;
    }
  }

  return { values, raw, issues, rowWarnings };
}

type ParseOutcome =
  | { ok: true; value: CellValue }
  | { ok: false; code: IssueCode };

function parseCell(field: ImportField, text: string): ParseOutcome {
  switch (field.type) {
    case "text":
      return text.length > MAX_TEXT_LENGTH ? { ok: false, code: "too_long" } : { ok: true, value: text };

    case "money": {
      const value = parseMoneyMinor(text);
      if (value === null) return { ok: false, code: "not_a_number" };
      return value < 0 ? { ok: false, code: "negative_not_allowed" } : { ok: true, value };
    }

    case "quantity": {
      const value = parseMilliUnits(text);
      if (value === null) return { ok: false, code: "not_a_number" };
      return value < 0 ? { ok: false, code: "negative_not_allowed" } : { ok: true, value };
    }

    case "integer": {
      const value = parseIntegerValue(text);
      if (value === null) return { ok: false, code: "not_a_number" };
      return value < 0 ? { ok: false, code: "negative_not_allowed" } : { ok: true, value };
    }

    case "duration": {
      const value = parseDurationMinutes(text);
      if (value === null) return { ok: false, code: "not_a_duration" };
      return value < 0 ? { ok: false, code: "negative_not_allowed" } : { ok: true, value };
    }

    case "percent": {
      const value = parsePercentBasisPoints(text);
      if (value === null) return { ok: false, code: "not_a_number" };
      return value < 0 ? { ok: false, code: "negative_not_allowed" } : { ok: true, value };
    }

    case "date": {
      const value = parseLocalDate(text);
      return value === null ? { ok: false, code: "not_a_date" } : { ok: true, value };
    }

    case "boolean": {
      const value = parseBoolean(text);
      return value === null ? { ok: false, code: "not_a_boolean" } : { ok: true, value };
    }

    case "phone": {
      const value = normalizePhone(text);
      return value === null ? { ok: false, code: "not_a_phone" } : { ok: true, value };
    }

    case "enum": {
      const match = field.options?.find(
        (option) => option.toLowerCase() === text.toLowerCase(),
      );
      return match === undefined ? { ok: false, code: "not_an_option" } : { ok: true, value: match };
    }
  }
}
