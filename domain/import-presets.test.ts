import { describe, expect, it } from "vitest";

import { parseCsv } from "@/domain/csv";
import { detectPreset, importPresets, type ImportPreset } from "@/domain/import-presets";
import { clientTemplate, serviceTemplate } from "@/domain/import-templates";

/*
 * Synthetic presets. They stand in for the real exports the list will hold,
 * and are deliberately not named after any real system: a test that claims to
 * know DIKIDI's header line would become the format nobody has seen.
 */
const clientsExport: ImportPreset = {
  id: "sample-clients",
  source: "Sample Booking",
  entity: "client",
  headers: ["ID клиента", "Клиент", "Мобильный номер", "E-mail", "Скидка", "Дата добавления"],
  columns: {
    external_id: "ID клиента",
    name: "Клиент",
    phone: "Мобильный номер",
    email: "E-mail",
  },
};

const servicesExport: ImportPreset = {
  id: "sample-services",
  source: "Sample Booking",
  entity: "service",
  headers: ["Позиция", "Стоимость, MDL", "Мин.", "Раздел прайса"],
  columns: { name: "Позиция", price: "Стоимость, MDL", duration: "Мин.", category: "Раздел прайса" },
};

const headersOf = (line: string) => parseCsv(`${line}\n`).headers;

describe("detectPreset", () => {
  it("ships no presets until a real export's header line is in hand", () => {
    expect(importPresets).toEqual([]);
    expect(detectPreset(clientTemplate, headersOf("Клиент;Мобильный номер"))).toBeNull();
  });

  it("recognises the export and maps every column it names", () => {
    const match = detectPreset(
      clientTemplate,
      headersOf("ID клиента;Клиент;Мобильный номер;E-mail;Скидка;Дата добавления"),
      [clientsExport],
    );

    expect(match?.preset.id).toBe("sample-clients");
    expect(match?.mapping).toEqual({ external_id: 0, name: 1, phone: 2, email: 3 });
  });

  it("does not care about the order or the case of the headers", () => {
    const match = detectPreset(
      clientTemplate,
      headersOf("дата добавления;E-MAIL;  клиент ;СКИДКА;мобильный номер;id клиента"),
      [clientsExport],
    );

    expect(match?.mapping).toEqual({ external_id: 5, name: 2, phone: 4, email: 1 });
  });

  it("allows columns the export grew since the sample", () => {
    const match = detectPreset(
      clientTemplate,
      headersOf("ID клиента;Клиент;Мобильный номер;E-mail;Скидка;Дата добавления;Бонусы"),
      [clientsExport],
    );

    expect(match?.preset.id).toBe("sample-clients");
  });

  it("refuses a file missing any header of the export", () => {
    // `Клиент` and a phone column are in every client list; without the rest
    // of the line this is somebody's own spreadsheet, not the export.
    const match = detectPreset(
      clientTemplate,
      headersOf("Клиент;Мобильный номер;E-mail"),
      [clientsExport],
    );

    expect(match).toBeNull();
  });

  it("only offers a preset for the kind of data being imported", () => {
    const match = detectPreset(
      serviceTemplate,
      headersOf("ID клиента;Клиент;Мобильный номер;E-mail;Скидка;Дата добавления"),
      [clientsExport, servicesExport],
    );

    expect(match).toBeNull();
  });

  it("prefers the preset naming more headers when two fit", () => {
    const narrower: ImportPreset = {
      ...clientsExport,
      id: "sample-clients-old",
      headers: ["Клиент", "Мобильный номер"],
      columns: { name: "Клиент", phone: "Мобильный номер" },
    };

    const match = detectPreset(
      clientTemplate,
      headersOf("ID клиента;Клиент;Мобильный номер;E-mail;Скидка;Дата добавления"),
      [narrower, clientsExport],
    );

    expect(match?.preset.id).toBe("sample-clients");
  });

  it("leaves the fields the preset does not name to the usual guess", () => {
    const partial: ImportPreset = {
      ...servicesExport,
      columns: { name: "Позиция", price: "Стоимость, MDL" },
    };

    const match = detectPreset(
      serviceTemplate,
      headersOf("Позиция;Стоимость, MDL;Мин.;Раздел прайса;Категория"),
      [partial],
    );

    // `Категория` is the template's own label, so the ordinary guess finds it.
    expect(match?.mapping).toMatchObject({ name: 0, price: 1, category: 4 });
  });

  it("never hands a preset's column to a guessed field as well", () => {
    // `Стоимость, MDL` contains the alias `стоимость`; once the preset gives it
    // to price, no other field may take it.
    const match = detectPreset(
      serviceTemplate,
      headersOf("Позиция;Стоимость, MDL;Мин.;Раздел прайса"),
      [{ ...servicesExport, columns: { name: "Позиция", price: "Стоимость, MDL" } }],
    );

    const columns = Object.values(match!.mapping).filter((column) => column !== null);
    expect(new Set(columns).size).toBe(columns.length);
  });
});
