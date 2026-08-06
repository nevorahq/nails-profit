import { existsSync } from "node:fs";

function databaseIdentity(value: string) {
  const url = new URL(value);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

/**
 * Integration and E2E suites truncate every application table. They must never
 * inherit the development DATABASE_URL: doing so deletes the account and
 * session used by the browser as soon as the first test file starts.
 */
export function configureTestDatabase() {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const developmentUrl = process.env.DATABASE_URL;
  const testUrl = process.env.TEST_DATABASE_URL;
  const testMigrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;

  if (!developmentUrl || !testUrl || !testMigrationUrl) {
    throw new Error(
      "Database tests require DATABASE_URL, TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL.",
    );
  }

  const developmentIdentity = databaseIdentity(developmentUrl);
  const testIdentity = databaseIdentity(testUrl);
  const migrationIdentity = databaseIdentity(testMigrationUrl);

  if (testIdentity === developmentIdentity) {
    throw new Error("Refusing to run destructive tests against the development database.");
  }
  if (testIdentity !== migrationIdentity) {
    throw new Error("TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL must target the same database.");
  }
  if (!new URL(testUrl).pathname.endsWith("_test")) {
    throw new Error("The destructive test database name must end with _test.");
  }

  process.env.DATABASE_URL = testUrl;
  process.env.MIGRATION_DATABASE_URL = testMigrationUrl;
}
