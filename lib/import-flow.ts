import { decodeCsv, detectDelimiter, parseCsv, type CsvDelimiter, type CsvEncoding } from "@/domain/csv";
import {
  buildPreview,
  type ColumnMapping,
  type FieldType,
  type ImportPreview,
} from "@/domain/import-mapping";
import { importTemplates, type ImportableEntity } from "@/domain/import-templates";
import type { Capability, MemberRole } from "@/domain/rbac";
import { canManageCatalogue } from "@/domain/rbac";
import { contactsToCsv, looksLikeVCard, parseVCards } from "@/domain/vcard";
import { formatBasisPoints, formatDuration, formatMoneyMinor } from "@/lib/format";
import type { AppLocale } from "@/i18n/messages";

/**
 * Shared pieces of the INT-002 flow, used by the routes and the wizard.
 */

/**
 * Section 6.1 has no "import" row, and inventing one would put a permission in
 * the product that the spec never granted. Import is a bulk write of ordinary
 * catalogue rows, so it borrows the capability of what it writes — at scope
 * "all", since a Master's `create_only` services permission covers adding their
 * own, not replacing the studio's catalogue.
 */
const ENTITY_CAPABILITY: Record<ImportableEntity, Capability> = {
  service: "services",
  specialist: "commissions",
  client: "clients",
  // Visits are guarded by `bookings`, the same capability the visit API checks.
  // That leaves the bulk import to Owner and Manager: a Master holds `bookings`
  // at scope "own", and a file that writes the studio's financial history is
  // not the place to work out whose rows are whose.
  visit: "bookings",
};

export function canImport(role: MemberRole, entity: ImportableEntity): boolean {
  return canManageCatalogue(role, ENTITY_CAPABILITY[entity]);
}

export function capabilityFor(entity: ImportableEntity): Capability {
  return ENTITY_CAPABILITY[entity];
}

export { MAX_IMPORT_BYTES } from "@/domain/import-limits";

export type UploadSource = Readonly<{
  kind: "csv" | "vcard";
  /** CSV text, which is what the job stores and every later step reparses. */
  text: string;
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
}>;

/**
 * The uploaded bytes as the CSV the rest of the flow reads.
 *
 * A phone's contacts file is turned into a client CSV here, once, so the job
 * stores the same kind of text as any other import and the mapping, preview,
 * confirm and history steps need not know where it came from. `selected` is
 * the positions the owner ticked in the browser, which read the file with the
 * same `parseVCards`; null takes every contact.
 */
export function readUpload(
  bytes: Uint8Array,
  entity: ImportableEntity,
  selected: ReadonlySet<number> | null,
): UploadSource | { error: "VCARD_NOT_CLIENTS" } {
  const decoded = decodeCsv(bytes);

  if (!looksLikeVCard(decoded.text)) {
    return { kind: "csv", text: decoded.text, encoding: decoded.encoding, delimiter: detectDelimiter(decoded.text) };
  }
  // A contact card is a person; there is no reading of it as a price list.
  if (entity !== "client") return { error: "VCARD_NOT_CLIENTS" };

  const contacts = parseVCards(decoded.text).filter((contact) => selected === null || selected.has(contact.index));
  return { kind: "vcard", text: contactsToCsv(contacts), encoding: decoded.encoding, delimiter: "," };
}

export function previewFor(
  entity: ImportableEntity,
  sourceText: string,
  delimiter: CsvDelimiter,
  mapping: ColumnMapping,
): ImportPreview {
  const parsed = parseCsv(sourceText, delimiter);
  return buildPreview(importTemplates[entity], mapping, parsed.rows);
}

/** The preview shape the wizard renders; rows are capped so a big file stays readable. */
export const PREVIEW_ROW_LIMIT = 20;

export type PreviewFormat = Readonly<{ currency: string; locale: AppLocale }>;

export function serializePreview(
  entity: ImportableEntity,
  preview: ImportPreview,
  format: PreviewFormat,
) {
  const template = importTemplates[entity];
  return {
    missing_required_fields: preview.missingRequiredFields,
    total: preview.rows.length,
    failed_count: preview.failed.length,
    skipped_count: preview.skipped.length,
    sample: preview.rows.slice(0, PREVIEW_ROW_LIMIT).map((row) => ({
      line: row.line,
      identity_kind: row.identityKind,
      values: template.fields.map((field) => ({
        key: field.key,
        value: formatCell(row.values[field.key] ?? null, field.type, format),
      })),
    })),
    failed: preview.failed.slice(0, PREVIEW_ROW_LIMIT).map((row) => ({
      line: row.line,
      issues: row.issues.map((issue) => ({ field: issue.field, code: issue.code, value: issue.value })),
    })),
    skipped: preview.skipped.slice(0, PREVIEW_ROW_LIMIT).map((row) => ({
      line: row.line,
      issues: row.issues.map((issue) => ({ field: issue.field, code: issue.code, value: issue.value })),
    })),
    warnings: preview.warnings.slice(0, PREVIEW_ROW_LIMIT).map((issue) => ({
      line: issue.line,
      field: issue.field,
      code: issue.code,
      value: issue.value,
    })),
  };
}

/**
 * Renders a parsed value the way the owner wrote it, not the way it is stored.
 *
 * The preview is where they decide whether the mapping is right, and money in
 * minor units reads as a hundredfold error: a file that says `240,50` shown
 * back as `24050` looks like the import misread it. Milli-units are worse
 * still — `10` ml becomes `10000`.
 */
function formatCell(value: unknown, type: FieldType, format: PreviewFormat): string {
  if (value === null) return "";

  const locale = `${format.locale}-MD`;

  switch (type) {
    case "money":
      return typeof value === "number" ? formatMoneyMinor(value, format.currency, locale) : String(value);
    case "duration":
      return typeof value === "number" ? formatDuration(value) : String(value);
    case "percent":
      return typeof value === "number" ? formatBasisPoints(value, locale) : String(value);
    case "date":
      return value instanceof Date ? value.toLocaleDateString(locale) : String(value);
    case "boolean":
      return value ? "да" : "нет";
    default:
      return value instanceof Date ? value.toISOString() : String(value);
  }
}

export function templateFields(entity: ImportableEntity) {
  return importTemplates[entity].fields.map((field) => ({
    key: field.key,
    label: field.label,
    required: field.required,
    type: field.type,
    hint: field.hint ?? null,
    options: field.options ?? null,
  }));
}
