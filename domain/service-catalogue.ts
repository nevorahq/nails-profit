import type { LocalizedText } from "@/i18n/localized-text";

/**
 * The fixed catalogue of service kinds, offered as suggestions when a service
 * is named.
 *
 * Ten entries, held in code rather than in a table: nothing about them is a
 * tenant's data, nobody edits them from the product, and they change when this
 * file changes. A table would have brought a migration, a seed command and an
 * idempotency story to serve a list shorter than the form that shows it.
 *
 * Every entry carries all three pilot languages. `service.name` is `jsonb`
 * keyed by locale, and the add form writes only the locale the owner is working
 * in — so choosing a suggestion is also the one moment the Romanian and English
 * names can be filled in without anyone typing them twice.
 *
 * These are kinds of work, not finished service names: a studio sells
 * "Маникюр + гель-лак", not "Маникюр". The suggestion is a start for the name,
 * which is why the field stays free text and the owner keeps typing after
 * picking one.
 */
export type ServiceCatalogueEntry = Readonly<{
  key: string;
  name: LocalizedText & { ru: string };
  /**
   * How long this kind of work takes, in minutes — the figure the setup screen
   * fills its duration field in with.
   *
   * A guess, and deliberately one: duration is half of «прибыль в час», and
   * asking for it beside the price doubles the typing on the one screen that
   * exists to reduce it. Every value here is editable in «Услуги» the moment
   * the owner disagrees, and a wrong hour is a visibly wrong hourly figure —
   * which is a better teacher than an empty field that silently withholds the
   * calculation.
   */
  durationMinutes: number;
}>;

export const serviceCatalogue: readonly ServiceCatalogueEntry[] = [
  { key: "manicure", name: { ru: "Маникюр", ro: "Manichiură", en: "Manicure" }, durationMinutes: 60 },
  { key: "coating", name: { ru: "Покрытие", ro: "Acoperire", en: "Coating" }, durationMinutes: 60 },
  {
    key: "reinforcement",
    name: {
      ru: "Укрепление и моделирование",
      ro: "Întărire și modelare",
      en: "Reinforcement and sculpting",
    },
    durationMinutes: 90,
  },
  {
    key: "extension",
    name: { ru: "Наращивание", ro: "Extensie", en: "Extensions" },
    durationMinutes: 120,
  },
  {
    key: "repair",
    name: { ru: "Ремонт ногтей", ro: "Repararea unghiilor", en: "Nail repair" },
    durationMinutes: 30,
  },
  {
    key: "removal",
    name: {
      ru: "Снятие покрытия / материала",
      ro: "Îndepărtarea acoperirii / materialului",
      en: "Coating and material removal",
    },
    durationMinutes: 30,
  },
  { key: "nail_art", name: { ru: "Дизайн", ro: "Design", en: "Nail art" }, durationMinutes: 30 },
  {
    key: "pedicure",
    name: { ru: "Педикюр", ro: "Pedichiură", en: "Pedicure" },
    durationMinutes: 90,
  },
  {
    key: "men",
    name: { ru: "Мужские услуги", ro: "Servicii pentru bărbați", en: "Men's services" },
    durationMinutes: 60,
  },
  {
    key: "spa",
    name: { ru: "SPA и уход", ro: "SPA și îngrijire", en: "Spa and care" },
    durationMinutes: 45,
  },
];

/** The entry a key names, or null — the one place a stored key is trusted. */
export function catalogueEntry(key: string): ServiceCatalogueEntry | null {
  return serviceCatalogue.find((entry) => entry.key === key) ?? null;
}

/**
 * Folds away the differences that should not affect a match: case, the
 * surrounding whitespace, and `ё`, which half the keyboards in the pilot write
 * as `е`.
 */
function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/ё/g, "е");
}

/**
 * The entries worth offering for what has been typed so far.
 *
 * Matched against every language rather than only the one on screen: an owner
 * working in Romanian who types "pedi" means the same row as one typing "педи",
 * and the catalogue knows both names for it.
 */
export function serviceSuggestions(
  query: string,
  catalogue: readonly ServiceCatalogueEntry[] = serviceCatalogue,
): ServiceCatalogueEntry[] {
  const needle = normalized(query);
  if (needle === "") return [...catalogue];

  return catalogue.filter((entry) =>
    Object.values(entry.name).some((name) => normalized(name).includes(needle)),
  );
}
