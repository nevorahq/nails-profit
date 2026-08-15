export type SystemMaterialPresetTarget = "service" | "add_on";

export type SystemMaterialPreset = Readonly<{
  key: string;
  target: SystemMaterialPresetTarget;
  label: Readonly<{ ru: string; ro: string; en: string }>;
  /** Quantities are persisted as thousandths, exactly like recipe items. */
  items: Readonly<Record<string, number>>;
}>;

const service = (
  key: string,
  label: SystemMaterialPreset["label"],
  items: Record<string, number>,
): SystemMaterialPreset => ({ key, target: "service", label, items });

const addOn = (
  key: string,
  label: SystemMaterialPreset["label"],
  items: Record<string, number>,
): SystemMaterialPreset => ({ key, target: "add_on", label, items });

const manicureBasic = {
  gloves: 2_000,
  lint_free_wipes: 4_000,
  orange_stick: 1_000,
  file: 1_000,
  cleanser: 1_000,
  cuticle_remover: 400,
  cuticle_oil: 500,
  hand_cream: 3_000,
  table_cover: 1_000,
  sterilization_share: 1_000,
};

const manicureGelPolish = {
  ...manicureBasic,
  lint_free_wipes: 6_000,
  buffer: 1_000,
  cleanser: 2_000,
  dehydrator: 250,
  primer_bond: 150,
  base: 150,
  gel_color: 300,
  top: 150,
};

const pedicureBasic = {
  gloves: 2_000,
  lint_free_wipes: 6_000,
  orange_stick: 1_000,
  file: 1_000,
  buffer: 1_000,
  pedicure_abrasive: 1_000,
  bath_liner: 1_000,
  pedi_soak: 1_000,
  callus_softener: 1_000,
  cuticle_remover: 500,
  foot_scrub: 10_000,
  foot_cream: 8_000,
  cleanser: 2_000,
  cuticle_oil: 500,
  sterilization_share: 1_000,
};

const extensionMedium = {
  gloves: 2_000,
  lint_free_wipes: 8_000,
  orange_stick: 1_000,
  file: 1_000,
  buffer: 1_000,
  sanding_band: 1_000,
  nail_form: 10_000,
  cleanser: 3_000,
  dehydrator: 300,
  primer_bond: 200,
  builder: 2_500,
  gel_color: 300,
  top: 180,
  cuticle_oil: 500,
  table_cover: 1_000,
  sterilization_share: 1_000,
};

/**
 * Product-owned starting estimates. Applying one copies it into a tenant's
 * versioned recipe; later edits affect that organization only and never mutate
 * this baseline or a completed visit.
 */
export const systemMaterialPresets: readonly SystemMaterialPreset[] = [
  service("MANICURE_BASIC", { ru: "Маникюр без покрытия", ro: "Manichiură fără acoperire", en: "Basic manicure" }, manicureBasic),
  service("MANICURE_GEL_POLISH", { ru: "Маникюр + гель-лак", ro: "Manichiură + ojă semipermanentă", en: "Gel polish manicure" }, manicureGelPolish),
  service("MANICURE_REINFORCEMENT", { ru: "Маникюр с укреплением", ro: "Manichiură cu întărire", en: "Reinforcement manicure" }, { ...manicureGelPolish, builder: 1_500 }),
  service("PEDICURE_BASIC", { ru: "Педикюр без покрытия", ro: "Pedichiură fără acoperire", en: "Basic pedicure" }, pedicureBasic),
  service("PEDICURE_GEL_POLISH", { ru: "Педикюр + гель-лак", ro: "Pedichiură + ojă semipermanentă", en: "Gel polish pedicure" }, { ...pedicureBasic, dehydrator: 200, primer_bond: 100, base: 100, gel_color: 200, top: 100 }),
  service("NAIL_EXTENSION_GEL_SHORT", { ru: "Гелевое наращивание — короткие", ro: "Extensie cu gel — scurte", en: "Gel extension — short" }, { ...extensionMedium, builder: 1_800 }),
  service("NAIL_EXTENSION_GEL_MEDIUM", { ru: "Гелевое наращивание — средние", ro: "Extensie cu gel — medii", en: "Gel extension — medium" }, extensionMedium),
  service("NAIL_EXTENSION_GEL_LONG", { ru: "Гелевое наращивание — длинные", ro: "Extensie cu gel — lungi", en: "Gel extension — long" }, { ...extensionMedium, builder: 3_700 }),
  addOn("REMOVAL_SOAK_OFF", { ru: "Снятие размачиванием", ro: "Îndepărtare prin înmuiere", en: "Soak-off removal" }, { remover: 12_000, foil_wrap: 10_000, cotton: 10_000, orange_stick: 1_000, lint_free_wipes: 3_000, sanding_band: 1_000 }),
  addOn("REMOVAL_EFILE", { ru: "Аппаратное снятие", ro: "Îndepărtare cu freza", en: "E-file removal" }, { sanding_band: 1_000 }),
  addOn("NAIL_REPAIR", { ru: "Ремонт ногтя", ro: "Repararea unghiei", en: "Nail repair" }, { builder: 300, nail_form: 1_000 }),
  addOn("FRENCH", { ru: "Френч", ro: "French", en: "French" }, { gel_color: 100 }),
  addOn("SIMPLE_ART", { ru: "Простой дизайн", ro: "Design simplu", en: "Simple art" }, { gel_color: 150 }),
  addOn("CHROME", { ru: "Втирка", ro: "Efect cromat", en: "Chrome" }, { chrome_powder: 100 }),
  addOn("RHINESTONES", { ru: "Стразы", ro: "Cristale", en: "Rhinestones" }, { rhinestones: 10_000 }),
];

export const serviceMaterialPresets = systemMaterialPresets.filter((preset) => preset.target === "service");
export const addOnMaterialPresets = systemMaterialPresets.filter((preset) => preset.target === "add_on");

export function systemMaterialSku(key: string) {
  return `SYSTEM:${key.toUpperCase()}`;
}

