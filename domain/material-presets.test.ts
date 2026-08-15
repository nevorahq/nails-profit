import { describe, expect, it } from "vitest";

import { addOnMaterialPresets, serviceMaterialPresets, systemMaterialPresets } from "@/domain/material-presets";
import { starterMaterials } from "@/domain/import-templates";

describe("system material presets", () => {
  it("ships a generic consumable catalogue with stable keys and no equipment", () => {
    expect(starterMaterials).toHaveLength(35);
    expect(new Set(starterMaterials.map((material) => material.key)).size).toBe(35);
    expect(starterMaterials.map((material) => material.key)).not.toContain("uv_lamp");
    expect(starterMaterials.map((material) => material.key)).not.toContain("autoclave");
  });

  it("contains the P0 service and add-on set without duplicate keys", () => {
    expect(serviceMaterialPresets).toHaveLength(8);
    expect(addOnMaterialPresets).toHaveLength(7);
    expect(new Set(systemMaterialPresets.map((preset) => preset.key)).size).toBe(15);
  });

  it("varies builder consumption by extension length", () => {
    const quantity = (key: string) => serviceMaterialPresets.find((preset) => preset.key === key)!.items.builder;
    expect(quantity("NAIL_EXTENSION_GEL_SHORT")).toBe(1_800);
    expect(quantity("NAIL_EXTENSION_GEL_MEDIUM")).toBe(2_500);
    expect(quantity("NAIL_EXTENSION_GEL_LONG")).toBe(3_700);
  });

  it("keeps removal out of base manicure profiles", () => {
    expect(serviceMaterialPresets.every((preset) => preset.items.remover === undefined)).toBe(true);
    expect(addOnMaterialPresets.find((preset) => preset.key === "REMOVAL_SOAK_OFF")?.items.remover).toBe(12_000);
  });
});
