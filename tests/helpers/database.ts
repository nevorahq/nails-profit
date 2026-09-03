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
  // No foreign keys and no tenant: the limiter counts callers, not rows that
  // belong to anyone. First simply because nothing depends on it.
  "rate_limit_window",
  "pilot_issue",
  "pilot_interaction",
  "pilot_product_event",
  "pilot_enrollment",
  "billing_provider_event",
  "organization_subscription",
  "notification_provider_event",
  "notification_outbox",
  "booking_verification",
  "booking_access_token",
  "booking_idempotency_key",
  "booking_line",
  "booking_hold",
  "booking",
  "financial_snapshot",
  "visit_line",
  "visit",
  // After `visit`, which points at a payment method with ON DELETE SET NULL —
  // dropping the method first would leave the delete to the constraint rather
  // than to this list.
  "payment_method",
  "tax_rule",
  "client",
  "labor_cost_rule",
  // Before the rule it belongs to: the FK cascades, but this list is meant to
  // state the order rather than lean on it.
  "commission_rule_service",
  "commission_rule",
  "availability_exception",
  "schedule_rule",
  "booking_settings",
  "specialist_service",
  "specialist_location",
  "workplace",
  "location",
  "service_add_on",
  "add_on",
  "specialist",
  "expense",
  "owner_draw",
  "service",
  "service_category",
  "invitation",
  "external_reference",
  "import_job",
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
