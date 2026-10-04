import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assess,
  EXIT_CODES,
  effectsOf,
  expectedObjects,
  formatReport,
  migrationHash,
  statementsOf,
} from "./db-status-core.mjs";

describe("what a migration creates", () => {
  it("reads a table with its columns, as drizzle-kit writes one", () => {
    const [statement] = statementsOf(
      'CREATE TABLE "visit" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"tip_minor" bigint DEFAULT 0 NOT NULL,\n\tCONSTRAINT "visit_x" CHECK (1 = 1)\n);',
    );
    expect(effectsOf(statement).map((effect) => effect.key)).toEqual([
      "table:visit",
      "column:visit.id",
      "column:visit.tip_minor",
    ]);
  });

  it("reads an enum and its values, and a value added later", () => {
    expect(effectsOf(`CREATE TYPE "public"."role" AS ENUM('owner', 'master''s')`).map((effect) => effect.key)).toEqual([
      "type:role",
      "enum:role.owner",
      "enum:role.master's",
    ]);
    expect(effectsOf(`ALTER TYPE "public"."role" ADD VALUE 'analyst'`)).toEqual([{ op: "add", key: "enum:role.analyst" }]);
  });

  it("reads added, dropped and renamed columns, and dropped tables and types", () => {
    expect(effectsOf('ALTER TABLE "visit" ADD COLUMN "tip_minor" bigint')).toEqual([
      { op: "add", key: "column:visit.tip_minor" },
    ]);
    expect(effectsOf('ALTER TABLE "visit" DROP COLUMN "tip_minor"')).toEqual([{ op: "drop", key: "column:visit.tip_minor" }]);
    expect(effectsOf('ALTER TABLE "visit" RENAME COLUMN "a" TO "b"')).toEqual([
      { op: "drop", key: "column:visit.a" },
      { op: "add", key: "column:visit.b" },
    ]);
    expect(effectsOf('DROP TABLE "material" CASCADE')).toEqual([{ op: "dropTable", table: "material" }]);
    expect(effectsOf('DROP TYPE "public"."material_unit"')).toEqual([{ op: "dropType", type: "material_unit" }]);
  });

  it("ignores what it does not check, and statements that were commented out", () => {
    expect(effectsOf('CREATE INDEX "visit_idx" ON "visit" ("id")')).toEqual([]);
    expect(effectsOf('ALTER TABLE "visit" ADD CONSTRAINT "x" CHECK (true)')).toEqual([]);
    expect(statementsOf('-- ALTER TABLE "material" drop column "match_key";\n--> statement-breakpoint\n')).toEqual([]);
  });
});

describe("which migration answers for an object", () => {
  it("is the last one to create it, and none once a later one drops it", () => {
    const owners = expectedObjects([
      { tag: "a", statements: ['CREATE TABLE "t" (\n\t"x" text\n)', `CREATE TYPE "k" AS ENUM('one')`] },
      { tag: "b", statements: ['ALTER TABLE "t" ADD COLUMN "y" text', 'DROP TYPE "k"'] },
      { tag: "c", statements: [`CREATE TYPE "k" AS ENUM('two')`, 'ALTER TABLE "t" DROP COLUMN "x"'] },
      { tag: "d", statements: ['DROP TABLE "gone" CASCADE'] },
    ]);
    expect(Object.fromEntries(owners)).toEqual({
      a: ["table:t"],
      b: ["column:t.y"],
      c: ["type:k", "enum:k.two"],
      d: [],
    });
  });

  it("takes a dropped table's columns with it", () => {
    const owners = expectedObjects([
      { tag: "a", statements: ['CREATE TABLE "t" (\n\t"x" text\n)'] },
      { tag: "b", statements: ['ALTER TABLE "t" ADD COLUMN "y" text'] },
      { tag: "c", statements: ['DROP TABLE "t" CASCADE'] },
    ]);
    expect([...owners.values()].flat()).toEqual([]);
  });

  it("finds the column of every file in this checkout's folder", () => {
    // The check is only as good as the parser on the files it actually reads.
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    const owners = expectedObjects(
      journal.entries.map((entry) => ({
        tag: entry.tag,
        statements: statementsOf(readFileSync(`drizzle/${entry.tag}.sql`, "utf8")),
      })),
    );
    expect(owners.get("0058_a_visit_keeps_what_the_client_left_on_top")).toEqual(["column:visit.tip_minor"]);
    expect(owners.get("0057_a_visit_line_carries_its_own_rule")).toContain("column:visit_line.commission_base");
  });
});

const entry = (idx, objects = [`column:t.c${idx}`]) => ({
  idx,
  tag: `000${idx}_m`,
  when: 1_000 + idx,
  hash: `h${idx}`,
  objects,
});
const row = (idx, hash = `h${idx}`) => ({ id: idx + 1, hash, created_at: String(1_000 + idx) });
const statuses = (result) => result.migrations.map((migration) => migration.status);

describe("the verdict", () => {
  const entries = [entry(0), entry(1), entry(2)];
  const everything = new Set(["column:t.c0", "column:t.c1", "column:t.c2"]);

  it("is up to date when every file is recorded and what it made is there", () => {
    const result = assess(entries, [row(0), row(1), row(2)], everything);
    expect(statuses(result)).toEqual(["applied", "applied", "applied"]);
    expect(result.verdict).toBe("ok");
    expect(EXIT_CODES[result.verdict]).toBe(0);
  });

  it("is behind when newer files are simply not run yet", () => {
    const result = assess(entries, [row(0)], new Set(["column:t.c0"]));
    expect(statuses(result)).toEqual(["applied", "pending", "pending"]);
    expect(result.verdict).toBe("pending");
    expect(EXIT_CODES[result.verdict]).toBe(2);
  });

  it("sees a file run by hand and never recorded, after one never run at all", () => {
    // 0058 never ran, 0059 was pasted into an SQL editor: the dashboard's case.
    const result = assess(entries, [row(0)], new Set(["column:t.c0", "column:t.c2"]));
    expect(statuses(result)).toEqual(["applied", "pending", "hand-applied"]);
    expect(result.verdict).toBe("broken");
    const report = formatReport(result).join("\n");
    expect(report).toContain("values ('h2', 1002)");
    expect(report).toContain("run the pending files by hand in order");
  });

  it("sees a file that db:migrate will never apply, behind a newer recorded one", () => {
    const result = assess(entries, [row(0), row(2)], new Set(["column:t.c0", "column:t.c2"]));
    expect(statuses(result)).toEqual(["applied", "skipped", "applied"]);
    expect(result.migrations[1].missing).toEqual(["column:t.c1"]);
    expect(formatReport(result).join("\n")).toContain("Run drizzle/0001_m.sql by hand, then record it");
  });

  it("tells a skipped file whose objects exist from one that never ran", () => {
    const result = assess(entries, [row(0), row(2)], everything);
    expect(statuses(result)[1]).toBe("skipped");
    expect(formatReport(result).join("\n")).toContain("Its objects exist; if the whole file was run, record it");
  });

  it("sees a file run in part", () => {
    const result = assess([entry(0), entry(1, ["column:t.a", "column:t.b"])], [row(0)], new Set(["column:t.c0", "column:t.a"]));
    expect(statuses(result)).toEqual(["applied", "partial"]);
    expect(result.verdict).toBe("broken");
  });

  it("sees a recorded file whose objects are gone, and one edited after it ran", () => {
    const result = assess(entries, [row(0), row(1, "other"), row(2)], new Set(["column:t.c1", "column:t.c2"]));
    expect(statuses(result)).toEqual(["missing", "edited", "applied"]);
    expect(result.verdict).toBe("broken");
  });

  it("does not call a file with nothing to check hand-applied", () => {
    const result = assess([entry(0), entry(1, [])], [row(0)], new Set(["column:t.c0"]));
    expect(statuses(result)).toEqual(["applied", "pending"]);
  });

  it("sees a database ahead of the checkout", () => {
    const result = assess([entry(0)], [row(0), row(5)], new Set(["column:t.c0"]));
    expect(result.unknown).toEqual([row(5)]);
    expect(result.verdict).toBe("broken");
    expect(formatReport(result).join("\n")).toContain("the database is ahead of this code");
  });

  it("reads a database with no journal at all as entirely pending", () => {
    expect(assess(entries, [], new Set()).verdict).toBe("pending");
  });
});

describe("drizzle's hash", () => {
  it("is the sha256 of the file as it is", () => {
    expect(migrationHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
