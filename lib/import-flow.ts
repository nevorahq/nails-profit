import { parseCsv, type CsvDelimiter } from "@/domain/csv";
import {
  buildPreview,
  type ColumnMapping,
  type FieldType,
  type ImportPreview,
} from "@/domain/import-mapping";
import { importTemplates, type ImportableEntity } from "@/domain/import-templates";
import type { Capability, MemberRole } from "@/domain/rbac";
import { canManageCatalogue } from "@/domain/rbac";
import { fromMilliUnits } from "@/domain/units";
import { formatBasisPoints, formatDuration, formatMoneyMinor } from "@/lib/format";
import type { AppLocale } from "@/i18n/messages";

/**
 * Shared pieces of the INT-002 flow, used by the routes and the wizard.
 */

/**
 * Section 6.1 has no "import" row, and inventing one would put a permission in
 * the product that the spec never granted. Import is a bulk write of ordinary
 * catalogue rows, so it borrows the capability of what it writes — at scope
 * "all", since a Master's `own`-scoped materials permission covers recording
 * their own consumption, not replacing the studio's catalogue.
 */
const ENTITY_CAPABILITY: Record<ImportableEntity, Capability> = {
  material: "materials",
  service: "services",
  specialist: "commissions",
  client: "clients",
};

export function canImport(role: MemberRole, entity: ImportableEntity): boolean {
  return canManageCatalogue(role, ENTITY_CAPABILITY[entity]);
}

export function capabilityFor(entity: ImportableEntity): Capability {
  return ENTITY_CAPABILITY[entity];
}

/**
 * A file large enough to matter is a file the owner should be splitting. The
 * cap exists so that a mis-selected 200 MB export cannot be read into memory,
 * parsed three times and stored in a row.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

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
    case "quantity":
      return typeof value === "number"
        ? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(fromMilliUnits(value))
        : String(value);
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
