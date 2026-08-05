import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import * as schema from "@/db/schema";

/**
 * Two connections on purpose.
 *
 * Tests exercise application code through `@/db`, which connects as
 * `nail_profit_app` — a non-owner role, so row level security actually applies.
 * That is the point: verifying isolation through a connection that can bypass it
 * would verify nothing.
 *
 * Cleanup and seeding need to reach across tenants, which the application role
 * cannot do by design, so they go through the migration owner. Keeping the two
 * apart is what stops a test from accidentally proving isolation with the wrong
 * credentials.
 */
const adminUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL!;

const adminClient = postgres(adminUrl, { max: 4, prepare: false });
export const adminDb = drizzle(adminClient, { schema });

/** Every application table, children before parents. */
const TABLES_IN_DELETE_ORDER = [
  "financial_snapshot",
  "consumption",
  "visit_line",
  "visit",
  "client",
  "recipe_item",
  "recipe",
  "commission_rule",
  "service_add_on",
  "add_on",
  "specialist",
  "material_price_version",
  "material",
  "service",
  "service_category",
  "invitation",
  "audit_event",
  "membership",
  "organization",
  "verification",
  "session",
  "account",
  '"user"',
] as const;

export async function resetDatabase() {
  await adminDb.execute(sql.raw(`TRUNCATE ${TABLES_IN_DELETE_ORDER.join(", ")} CASCADE`));
}

export async function closeTestConnections() {
  await adminClient.end({ timeout: 5 });
}

/**
 * Guards against the tables list drifting from the schema. A new tenant table
 * that nobody added here would leave rows behind and make later tests pass or
 * fail depending on what ran before them.
 */
export async function assertCleanupCoversEveryTable() {
  const rows = await adminDb.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  const known = new Set(TABLES_IN_DELETE_ORDER.map((name) => name.replaceAll('"', "")));
  const missing = [...rows].map((row) => row.tablename).filter((name) => !known.has(name));

  if (missing.length > 0) {
    throw new Error(
      `tests/helpers/database.ts does not clean up: ${missing.join(", ")}. Add them to TABLES_IN_DELETE_ORDER.`,
    );
  }
}
