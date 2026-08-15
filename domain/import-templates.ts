import type { ImportEntity } from "@/domain/import-identity";
import type { ImportTemplate } from "@/domain/import-mapping";

/**
 * The four files a salon actually has, spec INT-001.
 *
 * The aliases are the whole point of this file. A price list arrives with a
 * column called `Цена`, `цена за упаковку`, `Preț` or `Price` depending on who
 * made it, and every header the mapping step has to be told about by hand is a
 * minute of the thirty Gate 4 allows for the first calculation.
 */

const externalIdField = {
  key: "external_id",
  label: "ID в источнике",
  type: "text",
  required: false,
  aliases: ["id", "код", "внешний id", "external id", "cod"],
  hint: "Если есть — по нему определяется, что строка уже импортирована",
} as const;

export const materialTemplate: ImportTemplate = {
  entity: "material",
  label: "Материалы",
  naturalKey: ["name"],
  fields: [
    externalIdField,
    {
      key: "name",
      label: "Название",
      type: "text",
      required: true,
      aliases: ["наименование", "материал", "denumire", "material", "name", "продукт"],
    },
    {
      key: "base_unit",
      label: "Единица",
      type: "enum",
      required: true,
      options: ["ml", "g", "piece"],
      // Nobody writes `piece` on an invoice. These are the spellings the three
      // pilot languages actually use, including the abbreviated forms with a
      // full stop that Excel leaves exactly as typed.
      synonyms: {
        ml: ["мл", "мл.", "ml", "ml.", "милилитр", "миллилитр", "мілі"],
        g: ["г", "г.", "гр", "гр.", "g", "g.", "gr", "gr.", "грамм", "грамма", "грамов", "grame"],
        piece: ["шт", "шт.", "штук", "штука", "штуки", "pcs", "pc", "buc", "buc.", "бук", "ед", "piece", "pieces"],
      },
      aliases: ["ед", "ед изм", "единица измерения", "unit", "unitate", "мера"],
      hint: "ml, g или piece",
    },
    {
      key: "package_size",
      label: "Объём упаковки",
      type: "quantity",
      required: true,
      // The denominator of every cost derived from this material.
      positive: true,
      aliases: ["объем", "объём", "фасовка", "размер упаковки", "package size", "cantitate"],
    },
    {
      key: "package_price",
      label: "Цена упаковки",
      type: "money",
      required: true,
      aliases: ["цена", "стоимость", "закупка", "цена закупки", "price", "preț", "pret"],
    },
    {
      key: "sku",
      label: "Артикул",
      type: "text",
      required: false,
      aliases: ["sku", "артикул", "код товара"],
    },
    {
      key: "category",
      label: "Категория",
      type: "text",
      required: false,
      aliases: ["категория", "группа", "categorie", "category"],
    },
    {
      key: "supplier",
      label: "Поставщик",
      type: "text",
      required: false,
      aliases: ["поставщик", "furnizor", "supplier", "магазин"],
    },
  ],
};

export const serviceTemplate: ImportTemplate = {
  entity: "service",
  label: "Услуги",
  naturalKey: ["name"],
  fields: [
    externalIdField,
    {
      key: "name",
      label: "Название",
      type: "text",
      required: true,
      aliases: ["наименование", "услуга", "serviciu", "service", "name"],
    },
    {
      key: "price",
      label: "Цена",
      type: "money",
      required: false,
      aliases: ["стоимость", "цена услуги", "price", "preț", "pret", "тариф"],
      hint: "Можно оставить пустым — услуга импортируется, расчёт попросит цену позже",
    },
    {
      key: "duration",
      label: "Длительность",
      type: "duration",
      required: false,
      aliases: ["время", "продолжительность", "duration", "durata", "мин", "минут"],
      hint: "90, 1:30 или «1 ч 30 мин»",
    },
    {
      key: "category",
      label: "Категория",
      type: "text",
      required: false,
      aliases: ["категория", "группа", "categorie", "category"],
    },
  ],
};

export const specialistTemplate: ImportTemplate = {
  entity: "specialist",
  label: "Мастера",
  naturalKey: ["name"],
  fields: [
    externalIdField,
    {
      key: "name",
      label: "Имя",
      type: "text",
      required: true,
      aliases: ["мастер", "фио", "имя мастера", "nume", "name", "specialist", "сотрудник"],
    },
    {
      key: "cooperation_type",
      label: "Формат работы",
      type: "enum",
      required: false,
      options: ["commission", "rent", "staff"],
      aliases: ["формат", "тип", "занятость", "cooperation", "тип сотрудничества"],
      hint: "commission — процент, rent — аренда места, staff — оклад",
    },
    {
      key: "commission_percent",
      label: "Процент мастера",
      type: "percent",
      required: false,
      aliases: ["процент", "комиссия", "%", "commission", "comision", "ставка"],
    },
  ],
};

export const clientTemplate: ImportTemplate = {
  entity: "client",
  label: "Клиенты",
  // Phone before name: two clients are the same person when the number matches,
  // and duplicate names are ordinary. Section 11.3 puts the same unique index on
  // the normalized phone.
  naturalKey: ["phone", "name"],
  fields: [
    externalIdField,
    {
      key: "name",
      label: "Имя",
      type: "text",
      required: true,
      aliases: ["клиент", "фио", "имя клиента", "nume", "client", "name"],
    },
    {
      key: "phone",
      label: "Телефон",
      type: "phone",
      required: false,
      aliases: ["тел", "телефон", "номер", "phone", "telefon", "мобильный"],
    },
    {
      key: "email",
      label: "Email",
      type: "text",
      required: false,
      aliases: ["почта", "e-mail", "email", "mail"],
    },
  ],
};

export const importTemplates = {
  material: materialTemplate,
  service: serviceTemplate,
  specialist: specialistTemplate,
  client: clientTemplate,
} as const satisfies Partial<Record<ImportEntity, ImportTemplate>>;

export type ImportableEntity = keyof typeof importTemplates;

export const importableEntities = Object.keys(importTemplates) as ImportableEntity[];

export function isImportableEntity(value: string): value is ImportableEntity {
  return Object.hasOwn(importTemplates, value);
}

/**
 * The example file offered for download at the upload step.
 *
 * One filled row, not an empty header line: an owner who opens a blank template
 * has to guess what `piece` means and how to write a duration, and guessing is
 * what the mapping step then has to repair.
 */
export function templateSample(entity: ImportableEntity): string[][] {
  const headers = importTemplates[entity].fields.map((field) => field.label);
  const samples: Record<ImportableEntity, string[][]> = {
    material: [
      ["", "Гель-лак", "ml", "10", "240", "GL-001", "Покрытие", "Nail Shop"],
      ["", "Салфетки безворсовые", "piece", "500", "120", "", "Расходники", "Nail Shop"],
    ],
    service: [
      ["", "Маникюр с покрытием", "600", "90", "Маникюр"],
      ["", "Педикюр классический", "700", "1:30", "Педикюр"],
    ],
    specialist: [
      ["", "Ирина", "commission", "40"],
      ["", "Ольга", "rent", ""],
    ],
    client: [
      ["", "Мария", "069123456", "maria@example.com"],
      ["", "Анна", "+37369123457", ""],
    ],
  };
  return [headers, ...samples[entity]];
}

/**
 * Starter materials, so a first calculation is possible before anyone has a
 * price list to import. Prices are left out on purpose — an invented price is
 * exactly the kind of plausible wrong number section 8.8.1 refuses to produce.
 */
export const starterMaterials: readonly Readonly<{
  key: string;
  name: string;
  baseUnit: "ml" | "g" | "piece";
  category: string;
}>[] = [
  { key: "gloves", name: "Перчатки", baseUnit: "piece", category: "Одноразовые" },
  { key: "lint_free_wipes", name: "Салфетки безворсовые", baseUnit: "piece", category: "Одноразовые" },
  { key: "cotton", name: "Ватные диски", baseUnit: "piece", category: "Одноразовые" },
  { key: "orange_stick", name: "Апельсиновая палочка", baseUnit: "piece", category: "Одноразовые" },
  { key: "file", name: "Пилка", baseUnit: "piece", category: "Одноразовые" },
  { key: "buffer", name: "Баф", baseUnit: "piece", category: "Одноразовые" },
  { key: "sanding_band", name: "Шлифовальная лента", baseUnit: "piece", category: "Одноразовые" },
  { key: "pedicure_abrasive", name: "Педикюрный абразив", baseUnit: "piece", category: "Педикюр" },
  { key: "nail_form", name: "Форма для наращивания", baseUnit: "piece", category: "Одноразовые" },
  { key: "soft_gel_tip", name: "Типса soft gel", baseUnit: "piece", category: "Одноразовые" },
  { key: "foil_wrap", name: "Фольга для снятия", baseUnit: "piece", category: "Одноразовые" },
  { key: "table_cover", name: "Покрытие стола", baseUnit: "piece", category: "Одноразовые" },
  { key: "bath_liner", name: "Вкладыш для ванночки", baseUnit: "piece", category: "Педикюр" },
  { key: "sterilization_pouch", name: "Пакет для стерилизации", baseUnit: "piece", category: "Гигиена" },
  { key: "cleanser", name: "Обезжириватель", baseUnit: "ml", category: "Подготовка" },
  { key: "dehydrator", name: "Дегидратор", baseUnit: "ml", category: "Подготовка" },
  { key: "primer_bond", name: "Праймер / бонд", baseUnit: "ml", category: "Подготовка" },
  { key: "cuticle_remover", name: "Ремувер кутикулы", baseUnit: "ml", category: "Подготовка" },
  { key: "base", name: "База", baseUnit: "ml", category: "Покрытие" },
  { key: "gel_color", name: "Гель-лак", baseUnit: "ml", category: "Покрытие" },
  { key: "top", name: "Топ", baseUnit: "ml", category: "Покрытие" },
  { key: "builder", name: "Гель для укрепления / наращивания", baseUnit: "g", category: "Покрытие" },
  { key: "tip_adhesive", name: "Клей для типс", baseUnit: "ml", category: "Покрытие" },
  { key: "remover", name: "Ремувер", baseUnit: "ml", category: "Снятие" },
  { key: "cuticle_oil", name: "Масло для кутикулы", baseUnit: "ml", category: "Уход" },
  { key: "hand_cream", name: "Крем для рук", baseUnit: "ml", category: "Уход" },
  { key: "pedi_soak", name: "Средство для ванночки", baseUnit: "piece", category: "Педикюр" },
  { key: "callus_softener", name: "Размягчитель натоптышей", baseUnit: "piece", category: "Педикюр" },
  { key: "foot_scrub", name: "Скраб для ног", baseUnit: "g", category: "Педикюр" },
  { key: "foot_cream", name: "Крем для ног", baseUnit: "ml", category: "Педикюр" },
  { key: "surface_disinfection", name: "Дезинфекция поверхностей", baseUnit: "ml", category: "Гигиена" },
  { key: "instrument_disinfection", name: "Дезинфекция инструментов", baseUnit: "ml", category: "Гигиена" },
  { key: "sterilization_share", name: "Стерилизация на визит", baseUnit: "piece", category: "Гигиена" },
  { key: "chrome_powder", name: "Втирка / хром", baseUnit: "g", category: "Дизайн" },
  { key: "rhinestones", name: "Стразы", baseUnit: "piece", category: "Дизайн" },
];
