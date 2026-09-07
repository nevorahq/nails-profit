import { describe, expect, it } from "vitest";

import {
  deleteOrder,
  formatCounts,
  parseOptions,
  plural,
  resolveTarget,
} from "./purge-organizations-core.mjs";

const TEST_URL = "postgres://postgres:x@localhost:5432/nail_profit_test";
const PRODUCTION_URL = "postgres://postgres:x@db.supabase.co:5432/postgres";

describe("which database this is allowed to touch", () => {
  it("takes the test variable, not the one .env points at", () => {
    const target = resolveTarget(
      { TEST_MIGRATION_DATABASE_URL: TEST_URL, MIGRATION_DATABASE_URL: PRODUCTION_URL },
      parseOptions([]).options,
    );

    expect(target).toEqual({ url: TEST_URL, variable: "TEST_MIGRATION_DATABASE_URL" });
  });

  it("refuses a test variable that has been pointed somewhere else", () => {
    const target = resolveTarget(
      { TEST_MIGRATION_DATABASE_URL: PRODUCTION_URL },
      parseOptions([]).options,
    );

    expect(target.error).toContain("must end in _test");
  });

  it("refuses --prod until the database name is retyped", () => {
    const { options } = parseOptions(["--prod"]);
    const target = resolveTarget({ MIGRATION_DATABASE_URL: PRODUCTION_URL }, options);

    expect(target.error).toContain("--confirm-database=postgres");
  });

  it("accepts --prod once the name matches", () => {
    const { options } = parseOptions(["--prod", "--confirm-database=postgres"]);
    const target = resolveTarget({ MIGRATION_DATABASE_URL: PRODUCTION_URL }, options);

    expect(target).toEqual({ url: PRODUCTION_URL, variable: "MIGRATION_DATABASE_URL" });
  });

  it("does not let a mistyped name through", () => {
    const { options } = parseOptions(["--prod", "--confirm-database=nail_profit_test"]);
    const target = resolveTarget({ MIGRATION_DATABASE_URL: PRODUCTION_URL }, options);

    expect(target.error).toContain("--confirm-database=postgres");
  });
});

describe("the flags", () => {
  it("rehearses by default and only writes when told to", () => {
    expect(parseOptions([]).options).toMatchObject({
      apply: false,
      scope: "deleted",
      users: false,
      orphanUsers: false,
    });
    expect(parseOptions(["--apply", "--all", "--users"]).options).toMatchObject({
      apply: true,
      scope: "all",
      users: true,
    });
  });

  it("keeps the two account flags apart: one reaches the purge, the other the whole table", () => {
    expect(parseOptions(["--orphan-users"]).options).toMatchObject({
      users: false,
      orphanUsers: true,
    });
    expect(parseOptions(["--users", "--orphan-users"]).options).toMatchObject({
      users: true,
      orphanUsers: true,
    });
  });

  it("takes --orphan-users on its own, with no organization to purge", () => {
    const { options } = parseOptions(["--orphan-users", "--apply"]);

    expect(options).toMatchObject({ orphanUsers: true, apply: true, scope: "deleted" });
    expect(options.organizationIds).toEqual([]);
  });

  it("collects repeated organizations and switches scope to them", () => {
    const { options } = parseOptions([
      "--org",
      "0b5f2b6e-0d8a-4a6d-9f65-0a5f2c4f1a11",
      "--org=1c6f3c7f-1e9b-4b7e-8a76-1b6f3d5f2b22",
    ]);

    expect(options.scope).toBe("ids");
    expect(options.organizationIds).toHaveLength(2);
  });

  it("rejects an organization that is not a uuid rather than matching nothing", () => {
    expect(parseOptions(["--org", "studio-2026"]).error).toContain("uuid");
    expect(parseOptions(["--org"]).error).toContain("nothing");
  });

  it("rejects an argument it does not know instead of ignoring it", () => {
    expect(parseOptions(["--force"]).error).toContain("--force");
  });
});

describe("the order the deletes go in", () => {
  // The shape the real schema has: a visit points at a booking, a line points
  // at the visit, a photograph at the specialist it pictures.
  const tables = ["booking", "visit", "visit_line", "specialist", "specialist_avatar"];
  const keys = [
    { child: "visit", parent: "booking" },
    { child: "visit_line", parent: "visit" },
    { child: "specialist_avatar", parent: "specialist" },
    { child: "visit", parent: "specialist" },
  ];

  it("puts every table before the ones it references", () => {
    const { order, cycle } = deleteOrder(tables, keys);

    expect(cycle).toEqual([]);
    for (const { child, parent } of keys) {
      expect(order.indexOf(child)).toBeLessThan(order.indexOf(parent));
    }
    expect(order).toHaveLength(tables.length);
  });

  it("ignores references to tables outside the tenant set", () => {
    const { order } = deleteOrder(["expense"], [{ child: "expense", parent: "user" }]);

    expect(order).toEqual(["expense"]);
  });

  it("ignores a table that references itself, which no order could fix", () => {
    const { order, cycle } = deleteOrder(["service"], [{ child: "service", parent: "service" }]);

    expect(cycle).toEqual([]);
    expect(order).toEqual(["service"]);
  });

  it("names the tables in a cycle instead of leaving Postgres to refuse", () => {
    const { cycle } = deleteOrder(
      ["visit", "booking"],
      [
        { child: "visit", parent: "booking" },
        { child: "booking", parent: "visit" },
      ],
    );

    expect(cycle).toEqual(["booking", "visit"]);
  });
});

describe("the report", () => {
  it("counts one account without an s on the end", () => {
    expect(plural(1, "account")).toBe("1 account");
    expect(plural(0, "account")).toBe("0 accounts");
    expect(plural(12, "account")).toBe("12 accounts");
  });

  it("leaves out the tables nothing came from and puts the biggest first", () => {
    const report = formatCounts({ visit: 12, expense: 0, organization: 3 });

    expect(report).toContain("visit");
    expect(report).not.toContain("expense");
    expect(report.indexOf("visit")).toBeLessThan(report.indexOf("organization"));
  });

  it("says so when a rehearsal would delete nothing at all", () => {
    expect(formatCounts({ visit: 0 })).toBe("  (nothing)");
  });
});
