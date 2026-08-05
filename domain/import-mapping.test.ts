import { describe, expect, it } from "vitest";

import { parseCsv } from "@/domain/csv";
import {
  buildPreview,
  suggestMapping,
  type ColumnMapping,
  type ImportTemplate,
} from "@/domain/import-mapping";
import { materialTemplate, serviceTemplate, clientTemplate } from "@/domain/import-templates";

function preview(template: ImportTemplate, csv: string, override?: ColumnMapping) {
  const parsed = parseCsv(csv);
  const mapping = override ?? suggestMapping(template, parsed.headers);
  return { parsed, mapping, result: buildPreview(template, mapping, parsed.rows) };
}

describe("suggestMapping", () => {
  it("matches the headers a real price list uses", () => {
    const { mapping } = preview(
      materialTemplate,
      "Наименование;Ед. изм.;Фасовка;Цена упаковки\nГель;ml;10;240\n",
    );

    expect(mapping.name).toBe(0);
    expect(mapping.base_unit).toBe(1);
    expect(mapping.package_size).toBe(2);
    expect(mapping.package_price).toBe(3);
  });

  it("gives a column to the field that names it exactly", () => {
    // `цена` is an alias of package_price and a substring of "цена упаковки".
    // Matching field by field in order would let the loose match win the wrong
    // column whenever both exist.
    const { mapping } = preview(
      materialTemplate,
      "Название;Единица;Объём;Цена упаковки;Цена\nГель;ml;10;240;999\n",
    );

    expect(mapping.package_price).toBe(3);
  });

  it("never assigns one column to two fields", () => {
    const { mapping } = preview(materialTemplate, "Название;Единица;Объём;Цена\nГель;ml;10;240\n");
    const used = Object.values(mapping).filter((index): index is number => index !== null);

    expect(new Set(used).size).toBe(used.length);
  });

  it("leaves a field unmapped rather than guessing wildly", () => {
    const { mapping } = preview(materialTemplate, "Название;Единица;Объём;Цена\nГель;ml;10;240\n");
    expect(mapping.supplier).toBeNull();
  });
});

describe("buildPreview", () => {
  it("parses a clean file into values ready to write", () => {
    const { result } = preview(
      materialTemplate,
      "Название;Единица;Объём;Цена упаковки\nГель-лак;ml;10;240,50\n",
    );

    expect(result.failed).toEqual([]);
    expect(result.rows[0].values).toMatchObject({
      name: "Гель-лак",
      base_unit: "ml",
      package_size: 10_000,
      package_price: 24_050,
    });
  });

  it("keeps the good rows when one row is broken", () => {
    // INT-005: a 300-row file with two typos has to be usable.
    const { result } = preview(
      materialTemplate,
      [
        "Название;Единица;Объём;Цена упаковки",
        "Гель;ml;10;240",
        "Топ;ml;10;по запросу",
        "База;ml;10;200",
      ].join("\n"),
    );

    expect(result.rows.map((row) => row.values.name)).toEqual(["Гель", "База"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ line: 3 });
  });

  it("reports every problem in a row, not just the first", () => {
    // One pass through the file beats one round trip per cell.
    const { result } = preview(
      materialTemplate,
      "Название;Единица;Объём;Цена упаковки\n;литр;много;-5\n",
    );

    expect(result.failed[0].issues.map((issue) => [issue.field, issue.code])).toEqual([
      ["name", "required_missing"],
      ["base_unit", "not_an_option"],
      ["package_size", "not_a_number"],
      ["package_price", "negative_not_allowed"],
    ]);
  });

  it("points at the line the owner sees in Excel", () => {
    const { result } = preview(
      materialTemplate,
      "Название;Единица;Объём;Цена упаковки\nГель;ml;10;240\n\nТоп;ml;10;плохо\n",
    );

    expect(result.failed[0].line).toBe(4);
  });

  it("refuses to start when a required column is unmapped", () => {
    const { result } = preview(materialTemplate, "Название;Цена\nГель;240\n");

    expect(result.missingRequiredFields).toEqual(["base_unit", "package_size"]);
    expect(result.rows).toEqual([]);
  });

  it("accepts a row that omits its optional trailing cells", () => {
    // Excel drops trailing empty cells, so a short row is normal.
    const { result } = preview(
      materialTemplate,
      "Название;Единица;Объём;Цена упаковки;Артикул;Категория;Поставщик\nГель;ml;10;240\n",
    );

    expect(result.failed).toEqual([]);
    expect(result.rows[0].values.supplier).toBeNull();
  });

  it("skips the second copy of a row and says which line it kept", () => {
    const { result } = preview(
      materialTemplate,
      "Название;Единица;Объём;Цена упаковки\nГель;ml;10;240\nгель ;ml;10;240\n",
    );

    expect(result.rows).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ line: 3 });
    expect(result.skipped[0].issues[0]).toMatchObject({
      code: "duplicate_in_file",
      value: "строка 2",
    });
  });

  it("keeps two rows that only share an empty external id", () => {
    const { result } = preview(
      materialTemplate,
      "ID;Название;Единица;Объём;Цена упаковки\n;Гель;ml;10;240\n;Топ;ml;10;200\n",
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.identityKind === "fingerprint")).toBe(true);
  });

  it("uses the external id for identity when the file has one", () => {
    const { result } = preview(
      materialTemplate,
      "ID;Название;Единица;Объём;Цена упаковки\nSKU-1;Гель;ml;10;240\n",
    );

    expect(result.rows[0]).toMatchObject({ identityKind: "external", externalId: "SKU-1" });
  });

  it("imports a formula-looking name as text and warns about it", () => {
    // Rejecting the row would lose data we can store safely; the danger is the
    // export path, and `toCsv` neutralizes it there.
    const { result } = preview(
      materialTemplate,
      'Название;Единица;Объём;Цена упаковки\n"=HYPERLINK(""http://evil"")";ml;10;240\n',
    );

    expect(result.failed).toEqual([]);
    expect(result.rows[0].values.name).toBe('=HYPERLINK("http://evil")');
    expect(result.warnings[0]).toMatchObject({ code: "looks_like_formula", field: "name" });
  });

  it("does not warn about a negative number in a text column", () => {
    const { result } = preview(
      materialTemplate,
      "Название;Единица;Объём;Цена упаковки;Артикул\nГель;ml;10;240;-500\n",
    );

    expect(result.warnings).toEqual([]);
  });

  it("reads durations and leaves an unpriced service importable", () => {
    // SRV-007: the gap is flagged later, not used to reject the row.
    const { result } = preview(
      serviceTemplate,
      "Название;Цена;Длительность\nМаникюр;;1 ч 30 мин\n",
    );

    expect(result.failed).toEqual([]);
    expect(result.rows[0].values).toMatchObject({ price: null, duration: 90 });
  });

  it("normalizes a client phone to E.164 and dedups on it", () => {
    const { result } = preview(
      clientTemplate,
      "Имя;Телефон\nМария;069 123 456\nМария;+37369123456\n",
    );

    expect(result.rows[0].values.phone).toBe("+37369123456");
    // The same subscriber written two ways is one client. Fingerprinting the
    // source text instead of the parsed value would make this two.
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  it("gives a row the same identity however its phone was formatted", () => {
    // INT-003: the fingerprint has to survive the file being re-exported with
    // different formatting, or the second import doubles the client list.
    const first = preview(clientTemplate, "Имя;Телефон\nМария;069 123 456\n");
    const second = preview(clientTemplate, "Имя;Телефон\nМария;+373 69 123 456\n");

    expect(first.result.rows[0].externalId).toBe(second.result.rows[0].externalId);
  });

  it("rejects a phone that is not one", () => {
    const { result } = preview(clientTemplate, "Имя;Телефон\nМария;12\n");
    expect(result.failed[0].issues[0].code).toBe("not_a_phone");
  });
});
