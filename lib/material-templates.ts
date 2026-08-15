import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { materialPriceVersions, materialTemplates, materials } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { systemMaterialSku } from "@/domain/material-presets";
import type { MaterialDataSource, MaterialProfile } from "@/domain/material-provenance";
import { resolveLocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";

/**
 * Reading the global template catalogue and building tenant materials from it,
 * epic E3.1 §F1 and §F3.
 */

export type MaterialTemplateRow = Readonly<{
  id: string;
  slug: string;
  brand: string | null;
  name: string;
  /** Ties the row to a recipe preset ingredient; see `domain/material-presets`. */
  system_key: string | null;
  category: string;
  /** Null when the catalogue states no packaging; the owner supplies it. */
  package_size_milli_units: number | null;
  base_unit: "ml" | "g" | "piece";
  kind: "sku" | "aggregate";
  is_core: boolean;
  profiles: readonly string[];
}>;

export type TemplateQuery = Readonly<{
  profile?: MaterialProfile;
  coreOnly?: boolean;
  /** Free text over the resolved name and the brand. */
  search?: string;
}>;

/**
 * Read outside `withTenant`, because there is no tenant to set: the table has
 * no organization_id and its policy grants SELECT to the application role
 * unconditionally. Wrapping it in a tenant transaction would suggest a scoping
 * that does not exist.
 */
export async function loadMaterialTemplates(
  locale: AppLocale,
  query: TemplateQuery = {},
): Promise<MaterialTemplateRow[]> {
  const conditions = [
    query.coreOnly ? eq(materialTemplates.isCore, true) : undefined,
    // Postgres array containment, so the filter runs in the database rather
    // than pulling 155 rows to drop most of them.
    query.profile ? sql`${materialTemplates.profiles} @> ARRAY[${query.profile}]::text[]` : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(materialTemplates)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(materialTemplates.sortOrder), asc(materialTemplates.slug));

  const search = query.search?.trim().toLowerCase() ?? "";

  return rows
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      brand: row.brand,
      system_key: row.systemKey,
      // The organization's own locale is both the requested and the fallback
      // locale here: a template with no Romanian name should still be findable
      // by a Romanian-speaking owner rather than vanish from the list.
      name: resolveLocalizedText(row.name, locale, locale) ?? row.slug,
      category: row.category,
      package_size_milli_units: row.packageSizeMilliUnits,
      base_unit: row.baseUnit,
      kind: row.kind,
      is_core: row.isCore,
      profiles: row.profiles,
    }))
    .filter(
      (row) =>
        search === "" ||
        row.name.toLowerCase().includes(search) ||
        (row.brand?.toLowerCase().includes(search) ?? false),
    );
}

/** What the owner typed alongside the template they picked. */
export type TemplatePriceInput = Readonly<{
  templateId: string;
  packagePriceMinor: number;
  /**
   * The packaging bought, in thousandths. Required when the template states
   * none, which is every generic entry in the fixed catalogue: it is the
   * divisor of the material's cost, and the catalogue does not know it.
   */
  packageSizeMilliUnits?: number;
  currency: "MDL" | "EUR";
}>;

export type TemplateConflict = Readonly<{
  template_id: string;
  code: "TEMPLATE_NOT_FOUND" | "ALREADY_EXISTS" | "PACKAGE_SIZE_REQUIRED";
  material_id: string | null;
}>;

export type FromTemplatesOutcome = Readonly<{
  created: number;
  skipped_existing: number;
  conflicts: readonly TemplateConflict[];
  material_ids: readonly string[];
}>;

/**
 * Creates one material per template, priced by what the owner entered.
 *
 * Existing materials are skipped rather than repriced. Fast Setup is the first
 * screen of onboarding, and someone who runs it a second time is completing a
 * catalogue, not correcting one — silently overwriting a price they had already
 * researched, with one typed into a list of fourteen, is the wrong reading of
 * that. Repricing has its own endpoint and its own audit trail.
 *
 * Two skip reasons, both real: the natural key catches a material typed by hand
 * under the same name, and the system key catches the same ingredient created
 * from a different template — the generic gel polish and the branded one both
 * map to `gel_color`, and a recipe preset can only consume one of them.
 */
export async function createMaterialsFromTemplates(
  tx: TenantTransaction,
  actor: Readonly<{ organizationId: string; userId: string }>,
  items: readonly TemplatePriceInput[],
  source: MaterialDataSource = "template",
): Promise<FromTemplatesOutcome> {
  if (items.length === 0) {
    return { created: 0, skipped_existing: 0, conflicts: [], material_ids: [] };
  }

  const templates = await db
    .select()
    .from(materialTemplates)
    .where(inArray(materialTemplates.id, items.map((item) => item.templateId)));
  const byId = new Map(templates.map((template) => [template.id, template]));

  const existing = await tx
    .select({
      id: materials.id,
      matchKey: materials.matchKey,
      baseUnit: materials.baseUnit,
      sku: materials.sku,
    })
    .from(materials)
    .where(isNull(materials.archivedAt));

  const takenByName = new Map<string, string>(
    existing.map((row) => [`${row.matchKey ?? ""}:${row.baseUnit}`, row.id]),
  );
  const takenBySystemKey = new Map<string, string>(
    existing.flatMap((row) => (row.sku ? [[row.sku, row.id] as [string, string]] : [])),
  );

  const conflicts: TemplateConflict[] = [];
  const created: string[] = [];
  let skipped = 0;

  for (const item of items) {
    const template = byId.get(item.templateId);
    if (!template) {
      conflicts.push({ template_id: item.templateId, code: "TEMPLATE_NOT_FOUND", material_id: null });
      continue;
    }

    const packageSizeMilliUnits = item.packageSizeMilliUnits ?? template.packageSizeMilliUnits;
    if (packageSizeMilliUnits === null || packageSizeMilliUnits === undefined) {
      // Refused rather than defaulted: a missing package size is an unknown
      // divisor, and section 8.8.1 forbids answering with a cost that was
      // computed from a number nobody supplied.
      conflicts.push({
        template_id: item.templateId,
        code: "PACKAGE_SIZE_REQUIRED",
        material_id: null,
      });
      continue;
    }

    const name = templateMaterialName(template);
    const sku = template.systemKey ? systemMaterialSku(template.systemKey) : null;
    const nameKey = `${matchKeyOf(name)}:${template.baseUnit}`;

    const clash = takenByName.get(nameKey) ?? (sku ? takenBySystemKey.get(sku) : undefined);
    if (clash) {
      conflicts.push({ template_id: item.templateId, code: "ALREADY_EXISTS", material_id: clash });
      skipped += 1;
      continue;
    }

    const [material] = await tx
      .insert(materials)
      .values({
        organizationId: actor.organizationId,
        name,
        sku,
        category: template.category,
        baseUnit: template.baseUnit,
        kind: template.kind,
        source,
        templateId: template.id,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: materials.id });

    await tx.insert(materialPriceVersions).values({
      organizationId: actor.organizationId,
      materialId: material.id,
      packagePriceMinor: item.packagePriceMinor,
      packageSizeMilliUnits,
      costingMode: "quantity",
      priceSource: source,
      currency: item.currency,
      createdBy: actor.userId,
    });

    // Within one request, so a list naming the same template twice creates one
    // material rather than tripping the unique index on the second insert.
    takenByName.set(nameKey, material.id);
    if (sku) takenBySystemKey.set(sku, material.id);
    created.push(material.id);
  }

  return {
    created: created.length,
    skipped_existing: skipped,
    conflicts,
    material_ids: created,
  };
}

/**
 * The name the material gets. Russian, matching `starterMaterials`, because the
 * material's own name is not localized — spec section 11.2 gives translations to
 * services, categories and add-ons, not to materials — and the P&L breakdown in
 * `lib/period.ts` groups generic materials by exactly these names.
 */
export function templateMaterialName(
  template: Readonly<{ brand: string | null; name: Record<string, string | undefined> }>,
): string {
  const base = template.name.ru ?? template.name.en ?? template.name.ro ?? "";
  return template.brand ? `${template.brand} ${base}` : base;
}

/** Mirrors the generated `material.match_key` column, for checks made before the insert. */
export function matchKeyOf(name: string): string {
  return name.toLowerCase().replace(/[^0-9a-zа-яîăâșț]+/gi, "");
}
