import { defineConfig } from "drizzle-kit";

/**
 * Migrations against the destructive test database, and nothing else.
 *
 * `drizzle-kit` loads `.env` itself, and it does so *after* the shell — so
 * exporting `MIGRATION_DATABASE_URL=<test url>` before the command does not
 * redirect it. A deployment whose `.env` points at production therefore has one
 * plausible-looking way to migrate production by accident, which is exactly the
 * mistake this file exists to make impossible:
 *
 *     npm run db:migrate:test
 *
 * reads a different variable entirely, and refuses to run against anything that
 * is not a `_test` database. The same fail-fast the integration and E2E suites
 * already apply in `tests/test-database-env.ts`, moved to the one command that
 * changes a schema.
 */
const url = process.env.TEST_MIGRATION_DATABASE_URL;

if (!url) {
  throw new Error("TEST_MIGRATION_DATABASE_URL is required by drizzle.test.config.ts");
}

if (!new URL(url).pathname.endsWith("_test")) {
  throw new Error(
    `Refusing to migrate ${new URL(url).pathname}: this config only targets a database whose name ends in _test.`,
  );
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
