#!/usr/bin/env node

/**
 * `npm run db:status` — does the database have the schema this checkout reads?
 *
 * Read-only: one `read only` transaction, nothing written whatever it finds,
 * so it is safe against the production URL `.env` holds — which is the point:
 * it is what to run there before `db:migrate` and before a deploy. The checks
 * and why they exist are in `db-status-core.mjs`.
 *
 * Exit code 0: up to date. 2: behind, and `db:migrate` alone fixes it.
 * 1: anything `db:migrate` would not fix, or the database could not be read.
 *
 *   npm run db:status                 MIGRATION_DATABASE_URL, else DATABASE_URL
 *   npm run db:status -- --test       TEST_MIGRATION_DATABASE_URL
 *   npm run db:status -- --json       the same verdict as JSON, for CI
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { assess, EXIT_CODES, expectedObjects, formatReport, migrationHash, statementsOf } from "./db-status-core.mjs";
import { urlVariablesFor } from "./migrate-down.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");

const FOLDER = join(process.cwd(), "drizzle");

export function readCheckout() {
  const journal = JSON.parse(readFileSync(join(FOLDER, "meta", "_journal.json"), "utf8"));
  const files = journal.entries.map((entry) => {
    const source = readFileSync(join(FOLDER, `${entry.tag}.sql`)).toString();
    return { ...entry, hash: migrationHash(source), statements: statementsOf(source) };
  });
  const objects = expectedObjects(files);
  return files.map(({ idx, tag, when, hash }) => ({ idx, tag, when, hash, objects: objects.get(tag) }));
}

/**
 * The catalogue, not `information_schema`: the latter hides columns of tables
 * the role holds no privilege on, and a column that is merely invisible would
 * read as one that is missing.
 */
async function readDatabase(tx) {
  const [{ journal }] = await tx`select to_regclass('drizzle.__drizzle_migrations') is not null as journal`;
  const applied = journal
    ? await tx`select id, hash, created_at from drizzle.__drizzle_migrations order by created_at`
    : [];

  const rows = await tx`
    select 'table:' || c.relname as key
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
    union all
    select 'column:' || c.relname || '.' || a.attname
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
    union all
    select 'type:' || t.typname
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typtype = 'e'
    union all
    select 'enum:' || t.typname || '.' || e.enumlabel
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
  `;
  return { applied, present: new Set(rows.map((row) => row.key)) };
}

/**
 * The verdict for one database against this checkout. Shared with
 * `db-migrate.mjs`, which will not start a run this calls broken.
 */
export async function databaseStatus(url, variable) {
  const entries = readCheckout();
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  let database;
  try {
    database = await sql.begin("read only", readDatabase);
  } catch (error) {
    // The application's role cannot read Drizzle's schema; say which role can.
    if (error.code === "42501") {
      throw new Error(`${variable} cannot read drizzle.__drizzle_migrations: use the migration role (MIGRATION_DATABASE_URL).`);
    }
    throw error;
  } finally {
    await sql.end();
  }
  return assess(entries, database.applied, database.present);
}

async function main() {
  const args = process.argv.slice(2);
  const variables = urlVariablesFor(args);
  const variable = variables.find((name) => process.env[name]?.trim());
  if (!variable) throw new Error(`Set ${variables.join(" or ")}.`);

  const result = await databaseStatus(process.env[variable], variable);
  const { host, pathname } = new URL(process.env[variable]);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ database: `${host}${pathname}`, ...result }, null, 2));
  } else {
    console.log(`${variable} → ${host}${pathname}\n`);
    for (const line of formatReport(result)) console.log(line);
  }
  process.exitCode = EXIT_CODES[result.verdict];
}

// Importable by `db-migrate.mjs` without running the report.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
