import type { ImportEntity } from "@/domain/import-identity";
import type { ImportTemplate } from "@/domain/import-mapping";

/**
 * The three files a salon actually has, spec INT-001.
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
