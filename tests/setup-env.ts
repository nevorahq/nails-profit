/**
 * Integration tests need the same environment the server uses. Loaded before any
 * test file, so `@/db` picks up DATABASE_URL when it is first imported.
 */
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "Integration tests need DATABASE_URL. Run `cp .env.example .env`, `docker compose up -d` and `npm run db:migrate` first.",
  );
}
