import { normalizeHeader } from "@/domain/csv";
import { suggestMapping, type ColumnMapping, type ImportTemplate } from "@/domain/import-mapping";
import type { ImportableEntity } from "@/domain/import-templates";

/**
 * Exports we recognise by their header line, so a file from another booking
 * system maps itself rather than asking the owner to match columns by hand.
 *
 * A preset is written from a real export's header line and nothing else — a
 * guessed format is worse than none, because it maps a column with confidence
 * the owner then has no reason to check. Until a sample arrives the list stays
 * empty and every file goes through `suggestMapping` as before.
 */
export type ImportPreset = Readonly<{
  id: string;
  /** The system's name as the owner knows it, shown when the file is recognised. */
  source: string;
  entity: ImportableEntity;
  /**
   * The export's whole header line. The whole line, not just the columns we
   * read, is what tells one system's file from another's: `Имя` and `Телефон`
   * are in every client list, the other eight columns are what make it DIKIDI.
   */
  headers: readonly string[];
  /** Template field key -> the header in `headers` that carries it. */
  columns: Readonly<Record<string, string>>;
}>;

export const importPresets: readonly ImportPreset[] = [];

export type PresetMatch = Readonly<{ preset: ImportPreset; mapping: ColumnMapping }>;

/**
 * The preset whose header line the file carries, with the mapping it gives.
 *
 * Every header of the preset has to be in the file; order and case do not
 * matter, and extra columns are allowed — systems add columns between versions
 * far more often than they rename them. When several presets fit, the one that
 * names the most headers wins, since it is the more specific claim.
 *
 * Fields the preset does not name keep what `suggestMapping` found for them,
 * on columns the preset left free, so the owner still gets a guess for them.
 */
export function detectPreset(
  template: ImportTemplate,
  headers: readonly string[],
  presets: readonly ImportPreset[] = importPresets,
): PresetMatch | null {
  const normalized = headers.map(normalizeHeader);
  const present = new Set(normalized.filter((header) => header !== ""));

  const preset = presets
    .filter((candidate) => candidate.entity === template.entity)
    .filter((candidate) => candidate.headers.every((header) => present.has(normalizeHeader(header))))
    .sort((a, b) => b.headers.length - a.headers.length)[0];

  if (!preset) return null;

  const mapping: Record<string, number | null> = {};
  const claimed = new Set<number>();
  for (const field of template.fields) {
    const header = preset.columns[field.key];
    const index = header === undefined ? -1 : normalized.indexOf(normalizeHeader(header));
    mapping[field.key] = index === -1 ? null : index;
    if (index !== -1) claimed.add(index);
  }

  const suggested = suggestMapping(template, headers);
  for (const field of template.fields) {
    const column = suggested[field.key];
    if (mapping[field.key] !== null || column == null || claimed.has(column)) continue;
    mapping[field.key] = column;
    claimed.add(column);
  }

  return { preset, mapping };
}
