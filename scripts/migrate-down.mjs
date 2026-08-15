#!/usr/bin/env node

/**
 * Rolls back the most recently applied migration, epic E3.1 §5.1.
 *
 * `drizzle-kit` generates `up` only, so a rollback here is a hand-written file
 * under `drizzle/down/` named after its migration. That is a deliberate choice
 * rather than a gap: a generated `down` is a guess about intent — it cannot
 * know whether dropping a column is meant to discard the data or to restore
 * what was there before — and a rollback nobody has read is not a rollback
 * anyone should run against a database with money in it.
 *
 * Consequently only migrations that ship a down file can be undone, and the
 * script says so rather than skipping ahead to one that can. Skipping would
 * apply the wrong file's rollback to the wrong schema.
 *
 * The whole rollback runs in one transaction with the journal delete, so a
 * failure half way through leaves the database and Drizzle's record of it
 * agreeing with each other. PostgreSQL rolls back DDL like anything else.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { openOperatorConnection } from "./ops-connection.mjs";

// The other operator jobs are run by a scheduler that supplies the environment.
// This one is run by a person at a checkout, where the URLs live in `.env`.
if (existsSync(".env")) process.loadEnvFile(".env");

const JOURNAL = join(process.cwd(), "drizzle", "meta", "_journal.json");
const DOWN_DIRECTORY = join(process.cwd(), "drizzle", "down");

/** Statements are separated the same way `drizzle-kit` separates them. */
export function splitStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "" && !isCommentOnly(statement));
}

function isCommentOnly(statement) {
  return statement
    .split("\n")
    .every((line) => line.trim() === "" || line.trim().startsWith("--"));
}

/**
 * Which migration to undo: the newest row in Drizzle's journal, matched back to
 * a tag by `created_at`, which is the `when` the file's journal entry carries.
 *
 * Matched by timestamp rather than by position, because the two lists can
 * disagree — a checkout with a migration not yet applied is the normal state of
 * a branch — and undoing "the last file in the folder" would then run a
 * rollback for something the database never had.
 */
export function resolveTarget(journalEntries, appliedCreatedAt) {
  const entry = journalEntries.find((candidate) => String(candidate.when) === String(appliedCreatedAt));
  if (!entry) {
    return {
      error:
        `The database's newest migration (created_at ${appliedCreatedAt}) is not in drizzle/meta/_journal.json. ` +
        "The checkout is older than the database; pull the migration that applied it before rolling back.",
    };
  }
  return { tag: entry.tag };
}

/**
 * `--test` reads a different variable rather than trusting the shell to
 * override `.env`, for the reason spelled out in `drizzle.test.config.ts`: on a
 * checkout whose `.env` points at production, "I exported the test URL first"
 * is not a guarantee of anything.
 */
export function urlVariablesFor(argv) {
  return argv.includes("--test")
    ? ["TEST_MIGRATION_DATABASE_URL"]
    : ["MIGRATION_DATABASE_URL", "DATABASE_URL"];
}

async function main() {
  const sql = await openOperatorConnection(process.env, urlVariablesFor(process.argv.slice(2)));

  try {
    const [applied] = await sql`
      select id, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
    `;

    if (!applied) {
      console.log("Nothing to roll back: no migrations are applied.");
      return;
    }

    const journal = JSON.parse(readFileSync(JOURNAL, "utf8"));
    const target = resolveTarget(journal.entries, applied.created_at);
    if (target.error) throw new Error(target.error);

    const downFile = join(DOWN_DIRECTORY, `${target.tag}.sql`);
    if (!existsSync(downFile)) {
      throw new Error(
        `No rollback exists for ${target.tag}. Write drizzle/down/${target.tag}.sql — ` +
          "and read it against the migration it undoes before running this.",
      );
    }

    const statements = splitStatements(readFileSync(downFile, "utf8"));

    await sql.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
      await tx`delete from drizzle.__drizzle_migrations where id = ${applied.id}`;
    });

    console.log(`Rolled back ${target.tag} (${statements.length} statements).`);
  } finally {
    await sql.end();
  }
}

// Importable for the unit tests without opening a connection.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
