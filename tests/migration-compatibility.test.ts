import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Roadmap section 7.11: "Миграции выполняются через expand/migrate/contract",
 * and the rollback of section 7: "приложение откатывается только на
 * schema-compatible версию".
 *
 * Those two sentences are the same requirement seen from both ends. A rollback
 * is a rollback of the application, not of the database — the migration has
 * already run and is not coming back — so the previous version of the code has
 * to keep working against the new schema. Which makes one class of statement
 * expensive in a way it does not look: the column dropped in the same release
 * that stopped writing it turns "deploy the old build" from a thirty-second fix
 * into a restore from backup, at the worst possible moment to be finding that
 * out.
 *
 * So a migration either leaves the previous version working, or says why it
 * does not:
 *
 *   -- not-backward-compatible: the column was written by no released version
 *
 * The declaration is not a way of passing the check. It is the point of it: the
 * contract step of expand/migrate/contract is legitimate, and what goes wrong
 * is doing it in the same release as the expand, unnoticed. Writing the line
 * forces the question to be asked once, by the person who can answer it.
 *
 * Not flagged, deliberately: dropped indexes and dropped constraints. Both only
 * remove a restriction on the previous version, and `drizzle-kit` emits an
 * index drop for something as ordinary as widening a unique key.
 */
const MIGRATIONS_DIR = "drizzle";

const DECLARATION = /^--\s*not-backward-compatible:\s*(.+)$/im;

/**
 * Written before this check existed, applied everywhere, and left alone: an
 * applied migration is history, and editing one to satisfy a rule invented
 * afterwards is how a file stops describing what actually ran.
 */
const PREDATES_THE_RULE: Record<string, string> = {
  "0001_slim_banshee.sql":
    "service.name became jsonb during the first week; nothing was deployed against the text column",
  "0007_swift_tony_stark.sql":
    "visit.commission_type was added NOT NULL without a default, which would have refused the previous version's inserts",
};

type Violation = Readonly<{ file: string; rule: string; statement: string }>;

/** Drizzle separates statements with its own marker; comments are not rules. */
function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((statement) => statement !== "");
}

function violationsIn(file: string, sql: string): Violation[] {
  const found: Violation[] = [];

  for (const statement of statementsOf(sql)) {
    const flag = (rule: string) => found.push({ file, rule, statement });

    // The old version still selects from it, still writes to it, still knows
    // the old name.
    if (/\bDROP\s+TABLE\b/i.test(statement)) flag("drops a table");
    if (/\bDROP\s+COLUMN\b/i.test(statement)) flag("drops a column");
    if (/\bRENAME\b/i.test(statement)) flag("renames an object");

    // A type it can no longer read, or a value it never sends.
    if (/\bALTER\s+COLUMN\b.*\bSET\s+DATA\s+TYPE\b/i.test(statement)) flag("changes a column type");
    if (/\bALTER\s+COLUMN\b.*\bSET\s+NOT\s+NULL\b/i.test(statement)) flag("makes a column required");

    // The expand step done wrong: the previous version's INSERT does not
    // mention the column, so without a default every insert fails.
    if (
      /\bADD\s+COLUMN\b/i.test(statement) &&
      /\bNOT\s+NULL\b/i.test(statement) &&
      !/\bDEFAULT\b/i.test(statement) &&
      !/\bGENERATED\b/i.test(statement)
    ) {
      flag("adds a required column with no default");
    }
  }

  return found;
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((entry) => entry.endsWith(".sql"))
  .sort();

describe("migrations", () => {
  it("are all read by this check", () => {
    // A rename of the directory, or a generator that starts writing somewhere
    // else, would otherwise leave an empty check passing forever.
    expect(files.length).toBeGreaterThanOrEqual(22);
  });

  it("leave the previous application version working, or say why they do not", () => {
    const undeclared = files.flatMap((file) => {
      if (file in PREDATES_THE_RULE) return [];
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (DECLARATION.test(sql)) return [];
      return violationsIn(file, sql).map(({ rule, statement }) => `${file}: ${rule} — ${statement}`);
    });

    expect(undeclared).toEqual([]);
  });

  it("keeps the grandfathered list to migrations that would actually fail", () => {
    // If one of these is ever rewritten into something compatible, the entry
    // should go rather than sit there excusing nothing.
    for (const [file, reason] of Object.entries(PREDATES_THE_RULE)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(violationsIn(file, readFileSync(join(MIGRATIONS_DIR, file), "utf8"))).not.toEqual([]);
    }
  });

  it("wants a reason and not just the marker", () => {
    const declared = files.filter((file) =>
      DECLARATION.test(readFileSync(join(MIGRATIONS_DIR, file), "utf8")),
    );

    for (const file of declared) {
      const [, reason] = DECLARATION.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))!;
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });
});
