import { describe, expect, it } from "vitest";

import { parseCsv } from "@/domain/csv";
import {
  buildPreview,
  suggestMapping,
  type ColumnMapping,
  type ImportTemplate,
} from "@/domain/import-mapping";
import { serviceTemplate, specialistTemplate, clientTemplate } from "@/domain/import-templates";

function preview(template: ImportTemplate, csv: string, override?: ColumnMapping) {
  const parsed = parseCsv(csv);
  const mapping = override ?? suggestMapping(template, parsed.headers);
  return { parsed, mapping, result: buildPreview(template, mapping, parsed.rows) };
}

describe("suggestMapping", () => {
  it("matches the headers a real price list uses", () => {
    const { mapping } = preview(
      serviceTemplate,
      "Наименование;Стоимость;Продолжительность;Группа\nМаникюр;600;90;Руки\n",
    );

    expect(mapping.name).toBe(0);
    expect(mapping.price).toBe(1);
    expect(mapping.duration).toBe(2);
    expect(mapping.category).toBe(3);
  });

  it("gives a column to the field that names it exactly", () => {
    // `цена` is an alias of price and a substring of "цена услуги". Matching
    // field by field in order would let the loose match win the wrong column
    // whenever both exist.
    const { mapping } = preview(
      serviceTemplate,
      "Название;Цена услуги;Цена\nМаникюр;600;999\n",
    );

    expect(mapping.price).toBe(2);
  });

  it("never assigns one column to two fields", () => {
    const { mapping } = preview(serviceTemplate, "Название;Цена;Длительность\nМаникюр;600;90\n");
    const used = Object.values(mapping).filter((index): index is number => index !== null);

    expect(new Set(used).size).toBe(used.length);
  });

  it("leaves a field unmapped rather than guessing wildly", () => {
    const { mapping } = preview(serviceTemplate, "Название;Цена\nМаникюр;600\n");
    expect(mapping.category).toBeNull();
  });
});

describe("buildPreview", () => {
  it("parses a clean file into values ready to write", () => {
    const { result } = preview(
      serviceTemplate,
      "Название;Цена;Длительность;Категория\nМаникюр с покрытием;600,50;1:30;Руки\n",
    );

    expect(result.failed).toEqual([]);
    expect(result.rows[0].values).toMatchObject({
      name: "Маникюр с покрытием",
      price: 60_050,
      duration: 90,
      category: "Руки",
    });
  });

  it("keeps the good rows when one row is broken", () => {
    // INT-005: a 300-row file with two typos has to be usable.
    const { result } = preview(
      serviceTemplate,
      [
        "Название;Цена",
        "Маникюр;600",
        "Педикюр;по запросу",
        "Наращивание;900",
      ].join("\n"),
    );

    expect(result.rows.map((row) => row.values.name)).toEqual(["Маникюр", "Наращивание"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ line: 3 });
  });

  it("reports every problem in a row, not just the first", () => {
    // One pass through the file beats one round trip per cell.
    const { result } = preview(
      specialistTemplate,
      "Имя;Формат работы;Процент\n;подряд;-5\n",
    );

    expect(result.failed[0].issues.map((issue) => [issue.field, issue.code])).toEqual([
      ["name", "required_missing"],
      ["cooperation_type", "not_an_option"],
      ["commission_percent", "negative_not_allowed"],
    ]);
  });

  it("points at the line the owner sees in Excel", () => {
    const { result } = preview(
      serviceTemplate,
      "Название;Цена\nМаникюр;600\n\nПедикюр;плохо\n",
    );

    expect(result.failed[0].line).toBe(4);
  });

  it("refuses to start when a required column is unmapped", () => {
    const { result } = preview(serviceTemplate, "Цена;Длительность\n600;90\n");

    expect(result.missingRequiredFields).toEqual(["name"]);
    expect(result.rows).toEqual([]);
  });

  it("accepts a row that omits its optional trailing cells", () => {
    // Excel drops trailing empty cells, so a short row is normal.
    const { result } = preview(
      serviceTemplate,
      "Название;Цена;Длительность;Категория\nМаникюр;600\n",
    );

    expect(result.failed).toEqual([]);
    expect(result.rows[0].values.category).toBeNull();
  });

  it("skips the second copy of a row and says which line it kept", () => {
    const { result } = preview(
      serviceTemplate,
      "Название;Цена\nМаникюр;600\nманикюр ;600\n",
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
      serviceTemplate,
      "ID;Название;Цена\n;Маникюр;600\n;Педикюр;700\n",
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.identityKind === "fingerprint")).toBe(true);
  });

  it("uses the external id for identity when the file has one", () => {
    const { result } = preview(
      serviceTemplate,
      "ID;Название;Цена\nSRV-1;Маникюр;600\n",
    );

    expect(result.rows[0]).toMatchObject({ identityKind: "external", externalId: "SRV-1" });
  });

  it("imports a formula-looking name as text and warns about it", () => {
    // Rejecting the row would lose data we can store safely; the danger is the
    // export path, and `toCsv` neutralizes it there.
    const { result } = preview(
      serviceTemplate,
      'Название;Цена\n"=HYPERLINK(""http://evil"")";600\n',
    );

    expect(result.failed).toEqual([]);
    expect(result.rows[0].values.name).toBe('=HYPERLINK("http://evil")');
    expect(result.warnings[0]).toMatchObject({ code: "looks_like_formula", field: "name" });
  });

  it("does not warn about a negative number in a text column", () => {
    const { result } = preview(
      serviceTemplate,
      "Название;Цена;Категория\nМаникюр;600;-500\n",
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
