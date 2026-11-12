import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import {
  constantListLiteral,
  constantLiteral,
  dayLiteral,
  isUuid,
  instantLiteral,
  opaqueIdLiteral,
  uuidListLiteral,
  uuidLiteral,
} from "@/db/literal";

const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof uuidLiteral>) => dialect.sqlToQuery(fragment);

describe("inlined literals", () => {
  test("a uuid is written into the text, with no parameter", () => {
    expect(render(uuidLiteral("98bc5417-9e87-41c5-a6ee-a3d753ea1d10"))).toEqual({
      sql: "'98bc5417-9e87-41c5-a6ee-a3d753ea1d10'",
      params: [],
    });
  });

  test("an opaque id, a day, a moment and a constant are written the same way", () => {
    expect(render(opaqueIdLiteral("kQ3x_9-Ab")).sql).toBe("'kQ3x_9-Ab'");
    expect(render(dayLiteral("2026-11-01")).sql).toBe("'2026-11-01'");
    expect(render(instantLiteral(new Date("2026-11-01T00:00:00.000Z"))).sql).toBe("'2026-11-01T00:00:00.000Z'");
    expect(render(constantLiteral("pending_confirmation")).sql).toBe("'pending_confirmation'");
  });

  test.each([
    ["uuid", () => uuidLiteral("98bc5417-9e87-41c5-a6ee-a3d753ea1d10' or '1'='1")],
    ["uuid", () => uuidLiteral("not-a-uuid")],
    ["opaque id", () => opaqueIdLiteral("abc'; drop table x; --")],
    ["opaque id", () => opaqueIdLiteral("")],
    ["opaque id", () => opaqueIdLiteral("has space")],
    ["day", () => dayLiteral("2026-11-01' or true --")],
    ["day", () => dayLiteral("вчера")],
    ["constant", () => constantLiteral("Rent")],
    ["constant", () => constantLiteral("rent'")],
    ["constant", () => constantLiteral("a\\b")],
  ])("refuses a %s that is not the expected shape", (_what, inline) => {
    expect(inline).toThrow(/Refusing to inline/);
  });

  test("refuses an invalid date rather than writing «Invalid Date» into a statement", () => {
    expect(() => instantLiteral(new Date("nonsense"))).toThrow(/invalid date/);
  });

  test("a list of ids or constants is a parenthesised list with no parameters", () => {
    const a = "98bc5417-9e87-41c5-a6ee-a3d753ea1d10";
    const b = "18bc5417-9e87-41c5-a6ee-a3d753ea1d11";
    expect(render(uuidListLiteral([a, b]))).toEqual({ sql: `('${a}', '${b}')`, params: [] });
    expect(render(constantListLiteral(["vat", "turnover"]))).toEqual({ sql: "('vat', 'turnover')", params: [] });
  });

  test("a list refuses to be empty, and refuses any member of the wrong shape", () => {
    expect(() => uuidListLiteral([])).toThrow(/empty list/);
    expect(() => constantListLiteral([])).toThrow(/empty list/);
    expect(() => uuidListLiteral(["98bc5417-9e87-41c5-a6ee-a3d753ea1d10", "x' or 1=1 --"])).toThrow(/Refusing to inline/);
  });

  test("tells an id from anything else that arrives in an address", () => {
    expect(isUuid("98bc5417-9e87-41c5-a6ee-a3d753ea1d10")).toBe(true);
    expect(isUuid("98BC5417-9E87-41C5-A6EE-A3D753EA1D10")).toBe(true);
    expect(isUuid("98bc5417")).toBe(false);
    expect(isUuid("98bc5417-9e87-41c5-a6ee-a3d753ea1d10' --")).toBe(false);
  });
});
