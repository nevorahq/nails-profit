import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validate, type SeedTemplate } from "../scripts/seed-material-templates.mjs";
import { starterMaterials } from "@/domain/import-templates";

/**
 * The catalogue is data, and data rots quietly: an entry with no Romanian name,
 * or a system key pointing at an ingredient the recipe presets do not have,
 * breaks a screen without breaking a build.
 */
const { templates } = JSON.parse(
  readFileSync("seeds/material-templates.json", "utf8"),
) as { templates: SeedTemplate[] };

describe("the shipped material template catalogue", () => {
  it("passes the seeding command's own validation", () => {
    expect(validate(templates)).toEqual([]);
  });

  it("is the fixed system catalogue, whole", () => {
    expect(templates).toHaveLength(85);
    expect(new Set(templates.map((template) => template.slug)).size).toBe(85);
  });

  it("groups every entry under one of the catalogue's categories", () => {
    expect(new Set(templates.map((template) => template.category)).size).toBe(11);
    expect(templates.every((template) => template.category.trim() !== "")).toBe(true);
  });

  it("states a unit and a starting package size for every entry", () => {
    // The unit never changes. The package size is the packaging these materials
    // are usually sold in — a default the form lets the owner edit, because the
    // bottle on their table is what the cost has to divide by.
    expect(templates.every((template) => ["ml", "g", "piece"].includes(template.baseUnit))).toBe(true);
    expect(templates.every((template) => (template.packageSize ?? 0) > 0)).toBe(true);
  });

  it("carries no brand", () => {
    expect(templates.filter((template) => "brand" in template)).toEqual([]);
  });

  it("translates every row into all three pilot languages", () => {
    const untranslated = templates.filter(
      (template) => !template.name.ru?.trim() || !template.name.ro?.trim() || !template.name.en?.trim(),
    );

    expect(untranslated.map((template) => template.slug)).toEqual([]);
  });

  it("marks the materials almost every visit consumes as core", () => {
    const core = templates.filter((template) => template.isCore);
    expect(core.length).toBeGreaterThanOrEqual(12);
    expect(core.length).toBeLessThanOrEqual(20);
  });

  it("offers plain materials only", () => {
    // `material.kind` still supports an aggregate, and a tenant can create one
    // by hand; the fixed catalogue does not put averages in front of anyone.
    expect(templates.every((template) => template.kind === "sku")).toBe(true);
  });

  it("gives a system key exactly to the entries the recipe presets can match", () => {
    // The presets in `domain/material-presets.ts` find a material by
    // `sku = 'SYSTEM:<key>'`, and `lib/period.ts` groups the P&L breakdown by
    // name. Both work on the nine entries whose names match the starter list
    // outright; claiming a key for a name that does not match would point a
    // preset at the wrong ingredient.
    const starter = new Map(starterMaterials.map((material) => [material.name, material.key]));

    for (const template of templates) {
      expect(template.systemKey, template.slug).toBe(starter.get(template.name.ru) ?? null);
    }

    expect(templates.filter((template) => template.systemKey).length).toBe(9);
  });

  it("points every system key at an ingredient the recipe presets know", () => {
    const known = new Set(starterMaterials.map((material) => material.key));
    const dangling = templates.filter(
      (template) => template.systemKey !== null && !known.has(template.systemKey),
    );

    expect(dangling.map((template) => template.slug)).toEqual([]);
  });
});
