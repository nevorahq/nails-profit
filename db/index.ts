import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/env";
import * as schema from "@/db/schema";
import { lazyProxy } from "@/lib/lazy";

/**
 * The database handle, opened the first time something asks for a row.
 *
 * Lazily rather than at import, because importing this module used to mean
 * validating every server secret and opening a connection pool — and the build
 * imports it. Next collects page data by loading each route's module graph, and
 * the root layout reads the organization's language, so `/_not-found` pulled in
 * the whole chain: layout, locale, database, `getServerEnv`. On a build machine
 * with no secrets that threw, and a 404 page that cannot be prerendered without
 * a production DATABASE_URL is not a 404 page anyone can deploy.
 *
 * Nothing else changes. `db` and `sqlClient` behave exactly as before at
 * runtime; the connection simply opens on first use rather than on import, and
 * a missing variable is reported by the request that needed it rather than by
 * whatever happened to import a module first.
 */
const globalForDb = globalThis as unknown as {
  sqlClient?: ReturnType<typeof postgres>;
  drizzleDb?: PostgresJsDatabase<typeof schema>;
};

let client: ReturnType<typeof postgres> | undefined;
let database: PostgresJsDatabase<typeof schema> | undefined;

function connection() {
  const existing = client ?? globalForDb.sqlClient;
  if (existing) return (client = existing);

  const created = postgres(getServerEnv().DATABASE_URL, {
    // A single request can legitimately want more than one connection at
    // once: `/app/services` alone runs two `withTenant` transactions and a
    // plain read concurrently. `max: 2` left that third piece of work queued
    // behind the other two for the whole page, and reproduced reliably as the
    // page hanging rather than erroring — indistinguishable from "the
    // destination stream closed early". Development gets the same 10 as
    // production so the ordinary case has headroom instead of sitting at the
    // edge of capacity.
    max: 10,
    prepare: false,
  });
  client = created;
  // Development reloads the module on every edit; without the global each one
  // would leave its pool behind.
  if (process.env.NODE_ENV !== "production") globalForDb.sqlClient = created;
  return created;
}

function instance() {
  const existing = database ?? globalForDb.drizzleDb;
  if (existing) return (database = existing);

  const created = drizzle(connection(), { schema });
  database = created;
  if (process.env.NODE_ENV !== "production") globalForDb.drizzleDb = created;
  return created;
}

export const db: PostgresJsDatabase<typeof schema> = lazyProxy(instance);

/** Callable: the health check uses it as a tagged template. */
export const sqlClient: ReturnType<typeof postgres> = lazyProxy(connection, true);
