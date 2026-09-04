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
    {
      key: "commission_from",
      label: "Процент действует с",
      type: "date",
      required: false,
      // No bare "с": the third mapping pass matches on substring, and a single
      // letter is inside half the headers a price list has.
      aliases: ["действует с", "с даты", "начало", "commission from", "din data"],
      // Without this column a studio cannot import its own past. A rule starts
      // the day it is written (CST-009), and `selectCommissionRule` ignores one
      // that starts after the visit — so masters set up today earn nothing on
      // visits imported from last month, and every one of those rows is
      // refused. The date is asked for rather than guessed: what a master was
      // paid last spring is a fact the owner has and we do not.
      hint: "С какого дня действует процент. Пусто — с сегодняшнего дня",
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

/**
 * Completed visits, the fourth file INT-001 names.
 *
 * It carries no price. A visit copies price and duration from the catalogue as
 * it closes (`buildVisitDraft`), so a price column here would either be ignored
 * or become a second, disagreeing source for the one number the whole product
 * is judged on. Import the services first; the visits then cost themselves.
 */
export const visitTemplate: ImportTemplate = {
  entity: "visit",
  label: "Визиты",
  // A master cannot be at two tables in one minute, so the instant plus who did
  // what is already unique. The client is in the key for the file that carries
  // a date with no time — without it a day of one master's manicures collapses
  // into a single fingerprint and arrives as duplicates.
  naturalKey: ["date", "specialist", "service", "client"],
  fields: [
    externalIdField,
    {
      key: "date",
      label: "Дата и время",
      type: "date",
      required: true,
      aliases: ["дата", "время", "начало", "дата визита", "data", "date", "start"],
      hint: "03.04.2026 14:30 — по часам студии. Без времени визит встанет на полночь",
    },
    {
      key: "specialist",
      label: "Мастер",
      type: "text",
      required: true,
      aliases: ["мастер", "исполнитель", "сотрудник", "specialist", "maestru"],
      hint: "Мастер должен уже быть в студии — импортируйте мастеров до визитов",
    },
    {
      key: "service",
      label: "Услуга",
      type: "text",
      required: true,
      aliases: ["услуга", "процедура", "serviciu", "service"],
      hint: "Цена и плановая длительность берутся из справочника услуг",
    },
    {
      key: "client",
      label: "Клиент",
      type: "text",
      required: false,
      aliases: ["клиент", "гость", "имя клиента", "client", "nume client"],
      hint: "Кого нет в базе — заведётся по имени",
    },
    {
      key: "actual_duration",
      label: "Фактическая длительность",
      type: "duration",
      required: false,
      aliases: ["факт", "фактическое время", "длительность", "по факту", "duration", "durata"],
      hint: "Сколько заняло на самом деле. Пусто — считается по плановой",
    },
  ],
};

export const importTemplates = {
  service: serviceTemplate,
  specialist: specialistTemplate,
  client: clientTemplate,
  visit: visitTemplate,
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
      ["", "Ирина", "commission", "40", "01.01.2026"],
      ["", "Ольга", "rent", "", ""],
    ],
    client: [
      ["", "Мария", "069123456", "maria@example.com"],
      ["", "Анна", "+37369123457", ""],
    ],
    // The same two masters and two services the templates above sample, so an
    // owner who downloads all four files gets one story rather than four.
    visit: [
      ["", "03.04.2026 14:30", "Ирина", "Маникюр с покрытием", "Мария", ""],
      ["", "03.04.2026 16:00", "Ольга", "Педикюр классический", "Анна", "1:45"],
    ],
  };
  return [headers, ...samples[entity]];
}
