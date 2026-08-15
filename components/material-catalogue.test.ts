import { describe, expect, test } from "vitest";

import {
  availableMaterialSuggestions,
  buildMaterialSubmitRequest,
} from "@/components/material-catalogue";
import type { MaterialTemplateRow } from "@/lib/material-templates";

/**
 * The suggestions come from `material_template` rather than the fixed starter
 * list, so that choosing one fills in the brand, the unit and the package size
 * and leaves only the price (epic E3.1 §F1).
 */
function template(overrides: Partial<MaterialTemplateRow> = {}): MaterialTemplateRow {
  return {
    id: "template-base",
    slug: "generic-base",
    brand: null,
    name: "База",
    system_key: "base",
    category: "Покрытие",
    package_size_milli_units: null,
    base_unit: "ml",
    kind: "sku",
    is_core: true,
    profiles: ["manicure"],
    ...overrides,
  };
}

const catalogue: MaterialTemplateRow[] = [
  template(),
  template({ id: "template-top", slug: "generic-top", name: "Топ", system_key: "top" }),
  template({
    id: "template-oil",
    slug: "generic-oil",
    name: "Масло для кутикулы",
    system_key: "cuticle_oil",
  }),
  template({
    id: "template-kodi-base",
    slug: "kodi-baza-12ml",
    brand: "Kodi",
    name: "База каучуковая",
  }),
];

const pricedMaterial = {
  id: "priced",
  name: "База",
  system_key: "base",
  base_unit: "ml",
  current_price: {
    package_price_minor: 25_000,
    package_size_milli_units: 15_000,
    costing_mode: "quantity" as const,
    currency: "MDL",
    base_unit_cost_minor: 1_667,
  },
};

describe("material name suggestions", () => {
  test("offers the whole catalogue when the organization has nothing yet", () => {
    const suggestions = availableMaterialSuggestions([], catalogue, "");

    expect(suggestions).toHaveLength(catalogue.length);
    expect(suggestions.every((material) => material.materialId === null)).toBe(true);
    expect(suggestions.map((material) => material.key)).toContain("generic-base");
  });

  test("carries the unit, which is the part that never varies", () => {
    const [base] = availableMaterialSuggestions([], catalogue, "база");

    expect(base).toMatchObject({
      templateId: "template-base",
      baseUnit: "ml",
      // The unit comes from the catalogue; the packaging does not exist there.
      packageSizeMilliUnits: null,
    });
  });

  test("shows a branded row under its brand and name together", () => {
    const suggestions = availableMaterialSuggestions([], catalogue, "kodi");

    expect(suggestions).toEqual([
      expect.objectContaining({ name: "Kodi База каучуковая", brand: "Kodi" }),
    ]);
  });

  test("links an existing unpriced material instead of offering a duplicate", () => {
    const suggestions = availableMaterialSuggestions(
      [{ id: "top-id", name: "Мой топ", system_key: "top", base_unit: "ml", current_price: null }],
      catalogue,
      "мой топ",
    );

    expect(suggestions).toEqual([
      expect.objectContaining({ key: "generic-top", materialId: "top-id", name: "Мой топ" }),
    ]);
  });

  test("stops suggesting an ingredient once it has a price, branded rows included", () => {
    // Every row here maps to `base`, and the tenant already prices that
    // ingredient. Offering the Kodi row anyway would offer a material the
    // server refuses to create: `from-templates` skips a template whose system
    // key is taken, because a recipe preset can only consume one of them.
    //
    // simplification: one material per system key, upgrade when a pilot studio
    // needs two bases priced separately (a cheap one for reinforcement, a
    // premium one for clients) — which needs the preset mapping to choose.
    expect(availableMaterialSuggestions([pricedMaterial], catalogue, "база")).toEqual([]);
  });

  test("filters as the user types", () => {
    const suggestions = availableMaterialSuggestions([], catalogue, "масло");

    expect(suggestions.map((material) => material.key)).toEqual(["generic-oil"]);
  });

  test("does not treat a custom unpriced material as a catalogue row", () => {
    const suggestions = availableMaterialSuggestions(
      [
        {
          id: "custom",
          name: "Мой материал",
          system_key: null,
          base_unit: "ml",
          current_price: null,
        },
      ],
      catalogue,
      "мой материал",
    );

    expect(suggestions).toEqual([]);
  });
});

describe("material submission", () => {
  test("builds a catalogue row through the template endpoint, so provenance is recorded", () => {
    const request = buildMaterialSubmitRequest({
      selectedMaterial: {
        key: "generic-base",
        materialId: null,
        templateId: "template-base",
        name: "База",
        brand: null,
        baseUnit: "ml",
        category: "Покрытие",
        packageSizeMilliUnits: null,
        kind: "sku",
      },
      name: "База",
      baseUnit: "ml",
      costingMode: "quantity",
      pricePayload: { package_price_minor: 24_000, package_size: 15 },
    });

    expect(request.url).toBe("/api/v1/materials/from-templates");
    expect(request.headers?.["idempotency-key"]).toBeTruthy();
    expect(request.body).toMatchObject({
      items: [
        {
          template_id: "template-base",
          package_price_minor: 24_000,
          // The catalogue no longer states packaging: what the owner typed is
          // what every cost from this material divides by.
          package_size_milli_units: 15_000,
          currency: "MDL",
        },
      ],
    });
  });

  test("uses the price endpoint for a material that already exists", () => {
    const request = buildMaterialSubmitRequest({
      selectedMaterial: {
        key: "generic-base",
        materialId: "material-id",
        templateId: "template-base",
        name: "База",
        brand: null,
        baseUnit: "ml",
        category: "Покрытие",
        packageSizeMilliUnits: null,
        kind: "sku",
      },
      name: "База",
      baseUnit: "ml",
      costingMode: "quantity",
      pricePayload: { package_price_minor: 24_000, package_size: 15 },
    });

    expect(request.url).toBe("/api/v1/materials/material-id/prices");
    expect(request.body.base_unit).toBeUndefined();
  });

  test("falls back to the plain create for a name the catalogue does not have", () => {
    const request = buildMaterialSubmitRequest({
      selectedMaterial: null,
      name: "Своя паста",
      baseUnit: "g",
      costingMode: "quantity",
      pricePayload: { package_price_minor: 5_000, package_size: 50 },
    });

    expect(request.url).toBe("/api/v1/materials");
    expect(request.body).toMatchObject({ name: "Своя паста", base_unit: "g" });
  });

  test("keeps a per-service costing mode on the plain create, which templates cannot express", () => {
    const request = buildMaterialSubmitRequest({
      selectedMaterial: {
        key: "aggregate-visit-consumables",
        materialId: null,
        templateId: "template-consumables",
        name: "Расходники за визит",
        brand: null,
        baseUnit: "piece",
        category: "Одноразовые",
        packageSizeMilliUnits: null,
        kind: "aggregate",
      },
      name: "Расходники за визит",
      baseUnit: "piece",
      costingMode: "fixed_per_service",
      pricePayload: { fixed_cost_minor: 3_500 },
    });

    expect(request.url).toBe("/api/v1/materials");
    expect(request.body).toMatchObject({ costing_mode: "fixed_per_service" });
  });
});
