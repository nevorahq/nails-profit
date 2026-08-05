/**
 * Setup for the end-to-end suite.
 *
 * Same environment as the integration tests, plus the one seam the browser
 * would otherwise provide: `next/headers` only works inside a Next.js request
 * scope, so it is replaced by the store the client writes each request's cookie
 * into. Nothing else about the handlers is stubbed — the session, the RBAC
 * check, the tenant transaction and the SQL are the ones that ship.
 */
import { existsSync } from "node:fs";
import { beforeEach, vi } from "vitest";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "E2E tests need DATABASE_URL. Run `cp .env.example .env`, `docker compose up -d` and `npm run db:migrate` first.",
  );
}

/**
 * Rate limit counters are process-global, so without this a test's verdict
 * would depend on how many requests the tests before it happened to make.
 * The limits themselves are exercised deliberately, in one test.
 */
beforeEach(async () => {
  const { resetRateLimits } = await import("@/lib/rate-limit");
  resetRateLimits();
});

vi.mock("next/headers", async () => {
  const { currentSessionHeaders } = await import("../helpers/session");
  return {
    headers: async () => currentSessionHeaders(),
    cookies: async () => {
      throw new Error("cookies() is not available in E2E tests; the session travels in the cookie header");
    },
  };
});
