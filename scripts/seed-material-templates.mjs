#!/usr/bin/env node

/**
 * Loads `seeds/material-templates.json` into `material_template`, epic E3.1 §5.2.
 *
 * Idempotent by `slug`, not by content: running it twice updates the rows it
 * already wrote instead of adding a second copy, and correcting a package size
 * in the file is how that correction reaches every deployment. A natural key
 * over brand and name would have made the correction itself insert a duplicate
 * — and every organization that had already built a material from the old row
 * would keep pointing at it.
 *
 * Runs as the migration owner. `material_template` grants the application role
 * SELECT only (migration 0034), so this is the one writer the table has, and
 * pointing it at `DATABASE_URL` fails loudly rather than silently writing
 * nothing.
 *
 * Rows no longer in the file are deleted, because the file is the catalogue:
 * the fixed system list replaced an older one, and leaving the old rows behind
 * would show both at once in the one place the catalogue is read.
 *
 * A material built from a deleted template keeps working. `material.template_id`
 * is ON DELETE SET NULL, so the link goes and nothing else does — the name, the
 * unit, the price history and `source = 'template'` live on the material itself,
 * which is what the costing engine reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openOperatorConnection } from "./ops-connection.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");

const SEED_FILE = join(process.cwd(), "seeds", "material-templates.json");

/**
 * Mirrors `toMilliUnits` in domain/units.ts: quantities are thousandths, as
 * integers. Null passes through: a generic template states no packaging, and
 * the owner supplies the size of the package they bought.
 */
export function toMilliUnits(quantity) {
  if (quantity === null || quantity === undefined) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new RangeError(`packageSize must be a positive finite number or null, got ${quantity}`);
  }
  return Math.round(quantity * 1000);
}

const UNITS = new Set(["ml", "g", "piece"]);
const KINDS = new Set(["sku", "aggregate"]);
const PROFILES = new Set(["manicure", "pedicure", "extension"]);
const LOCALES = ["ru", "ro", "en"];

/**
 * Validated here rather than trusted to the column constraints, because the
 * useful error names the row. `material_template_size_positive` fired on insert
 * says a number was wrong somewhere in 155 of them.
 */
export function validate(templates) {
  const problems = [];
  const seen = new Set();

  templates.forEach((template, index) => {
    const at = template.slug ?? `#${index}`;
    if (!template.slug) problems.push(`${at}: missing slug`);
    if (seen.has(template.slug)) problems.push(`${at}: duplicate slug`);
    seen.add(template.slug);

    for (const locale of LOCALES) {
      if (!template.name?.[locale]?.trim()) problems.push(`${at}: missing ${locale} name`);
    }
    if (!template.category?.trim()) problems.push(`${at}: missing category`);
    if (!UNITS.has(template.baseUnit)) problems.push(`${at}: unit ${template.baseUnit}`);
    if (!KINDS.has(template.kind)) problems.push(`${at}: kind ${template.kind}`);
    if (template.packageSize !== null && !(template.packageSize > 0)) {
      problems.push(`${at}: packageSize ${template.packageSize}`);
    }
    for (const profile of template.profiles ?? []) {
      if (!PROFILES.has(profile)) problems.push(`${at}: profile ${profile}`);
    }
  });

  return problems;
}

export function urlVariablesFor(argv) {
  return argv.includes("--test")
    ? ["TEST_MIGRATION_DATABASE_URL"]
    : ["MIGRATION_DATABASE_URL", "DATABASE_URL"];
}

async function main() {
  const { templates } = JSON.parse(readFileSync(SEED_FILE, "utf8"));

  const problems = validate(templates);
  if (problems.length > 0) {
    throw new Error(`seeds/material-templates.json is invalid:\n  ${problems.join("\n  ")}`);
  }

  const sql = await openOperatorConnection(process.env, urlVariablesFor(process.argv.slice(2)));

  try {
    const before = await sql`select count(*)::int as total from material_template`;

    await sql.begin(async (tx) => {
      for (const template of templates) {
        await tx`
          insert into material_template
            (slug, brand, name, system_key, category, package_size_milli_units,
             base_unit, kind, is_core, profiles, sort_order)
          values
            (${template.slug}, ${template.brand ?? null}, ${sql.json(template.name)}, ${template.systemKey ?? null},
             ${template.category}, ${toMilliUnits(template.packageSize)}, ${template.baseUnit},
             ${template.kind}, ${template.isCore ?? false}, ${template.profiles ?? []}, ${template.sortOrder})
          on conflict (slug) do update set
            brand = excluded.brand,
            name = excluded.name,
            system_key = excluded.system_key,
            category = excluded.category,
            package_size_milli_units = excluded.package_size_milli_units,
            base_unit = excluded.base_unit,
            kind = excluded.kind,
            is_core = excluded.is_core,
            profiles = excluded.profiles,
            sort_order = excluded.sort_order,
            updated_at = now()
        `;
      }
    });

    const removed = await sql`
      delete from material_template
       where slug <> all(${templates.map((template) => template.slug)})
      returning slug
    `;

    const after = await sql`select count(*)::int as total from material_template`;
    const created = after[0].total + removed.length - before[0].total;

    console.log(
      `Seeded ${templates.length} templates: ${created} created, ${templates.length - created} updated in place` +
        (removed.length > 0 ? `, ${removed.length} removed.` : "."),
    );
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
