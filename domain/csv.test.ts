import { describe, expect, it } from "vitest";

import { decodeCsv, detectDelimiter, parseCsv } from "@/domain/csv";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("parseCsv", () => {
  it("reads a plain comma file", () => {
    const parsed = parseCsv("name,price\nМаникюр,300\n");

    expect(parsed.headers).toEqual(["name", "price"]);
    expect(parsed.rows).toEqual([{ line: 2, cells: ["Маникюр", "300"] }]);
  });

  it("reads the semicolon files Excel writes on a Russian locale", () => {
    const parsed = parseCsv("Название;Цена\nМаникюр;300,50\n");

    expect(parsed.delimiter).toBe(";");
    expect(parsed.rows[0].cells).toEqual(["Маникюр", "300,50"]);
  });

  it("does not let a comma inside a quoted cell choose the delimiter", () => {
    // Counting raw characters would find two commas and one semicolon and pick
    // the comma, collapsing the file into the wrong columns.
    const text = 'Название;Цена\n"Маникюр, классический";300\n"Педикюр, с покрытием";400\n';

    expect(detectDelimiter(text)).toBe(";");
    expect(parseCsv(text).rows[0].cells).toEqual(["Маникюр, классический", "300"]);
  });

  it("reads tab-separated exports", () => {
    const parsed = parseCsv("name\tprice\nМаникюр\t300\n");
    expect(parsed.delimiter).toBe("\t");
  });

  it("unescapes doubled quotes", () => {
    const parsed = parseCsv('name,note\n"Гель ""Люкс""",ok\n');
    expect(parsed.rows[0].cells).toEqual(['Гель "Люкс"', "ok"]);
  });

  it("keeps a quote that appears mid-cell as text", () => {
    // `Гель 5" стойкий` is a name, not an opening delimiter. Treating it as one
    // swallows the rest of the line and silently loses every column after it.
    const parsed = parseCsv('name,note\nГель 5" стойкий,ok\nТоп,ok\n');

    expect(parsed.rows[0].cells).toEqual(['Гель 5" стойкий', "ok"]);
    expect(parsed.rows).toHaveLength(2);
  });

  it("keeps a newline inside a quoted cell", () => {
    const parsed = parseCsv('name,note\n"Гель","первая\nвторая"\nПедикюр,ok\n');

    expect(parsed.rows[0].cells[1]).toBe("первая\nвторая");
    // The next row is on physical line 4, which is what the owner sees in Excel.
    expect(parsed.rows[1].line).toBe(4);
  });

  it("numbers rows by their line in the file", () => {
    const parsed = parseCsv("name\nа\n\nб\n");

    // The blank line is dropped, but "б" is still line 4 — an error report that
    // says line 3 would send the owner to the wrong row.
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 4]);
  });

  it("handles CRLF and a missing final newline", () => {
    const parsed = parseCsv("name,price\r\nМаникюр,300\r\nПедикюр,400");
    expect(parsed.rows.map((row) => row.cells[0])).toEqual(["Маникюр", "Педикюр"]);
  });

  it("strips the BOM from the first header", () => {
    const parsed = parseCsv(utf8("﻿name,price\nМаникюр,300\n"));
    // Without this the first column is "﻿name" and never matches a mapping.
    expect(parsed.headers[0]).toBe("name");
  });

  it("normalizes header case and spacing", () => {
    const parsed = parseCsv("  Название  Услуги ,ЦЕНА\nМаникюр,300\n");
    expect(parsed.headers).toEqual(["название услуги", "цена"]);
  });

  it("drops trailing empty rows without dropping real ones", () => {
    const parsed = parseCsv("name,price\nМаникюр,300\n,\n\n");
    expect(parsed.rows).toHaveLength(1);
  });
});

describe("decodeCsv", () => {
  it("decodes UTF-8", () => {
    expect(decodeCsv(utf8("Маникюр")).text).toBe("Маникюр");
  });

  it("decodes Windows-1251, which is what Excel writes here by default", () => {
    const bytes = new Uint8Array([0xcc, 0xe0, 0xed, 0xe8, 0xea, 0xfe, 0xf0]);
    const decoded = decodeCsv(bytes);

    expect(decoded.text).toBe("Маникюр");
    expect(decoded.encoding).toBe("windows-1251");
  });

  it("prefers UTF-8 when the bytes are valid UTF-8", () => {
    // Windows-1251 decodes any byte sequence without complaint, so the choice
    // has to be made this way round or every file becomes mojibake.
    expect(decodeCsv(utf8("Маникюр")).encoding).toBe("utf-8");
  });

  it("reads a Windows-1251 file end to end", () => {
    const bytes = new Uint8Array([
      0xcd, 0xe0, 0xe7, 0xe2, 0xe0, 0xed, 0xe8, 0xe5, 0x3b, 0xd6, 0xe5, 0xed, 0xe0, 0x0d, 0x0a,
      0xcc, 0xe0, 0xed, 0xe8, 0xea, 0xfe, 0xf0, 0x3b, 0x33, 0x30, 0x30, 0x0d, 0x0a,
    ]);
    const parsed = parseCsv(bytes);

    expect(parsed.headers).toEqual(["название", "цена"]);
    expect(parsed.rows[0].cells).toEqual(["Маникюр", "300"]);
  });
});
