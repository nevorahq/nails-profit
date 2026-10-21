import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import * as schema from "@/db/schema";

/**
 * The database client is opened with `fetch_types: false` (`db/index.ts`), which
 * saves a round trip on every new connection by not asking the server for the
 * types of its arrays. The price is that the driver can no longer parse or send
 * an array it was not told about — so an array column added to the schema would
 * come back as the string `{a,b}` and nothing would complain until a page
 * rendered it. This fails first, and says why.
 */
describe("the schema and `fetch_types: false`", () => {
  const tables = Object.values(schema).filter((value) => is(value, PgTable)) as unknown as PgTable[];

  test("has tables to check", () => {
    expect(tables.length).toBeGreaterThan(30);
  });

  test("declares no array column", () => {
    const arrays = tables.flatMap((table) =>
      Object.entries(getTableColumns(table))
        .filter(([, column]) => column.dataType === "array")
        .map(([name]) => name),
    );

    expect(arrays).toEqual([]);
  });
});
