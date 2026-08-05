import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * End-to-end tests: real route handlers, real Better Auth sessions, real
 * PostgreSQL. Separate from the integration config because these need one extra
 * seam — the `next/headers` mock in the setup file — and integration tests must
 * keep running without it.
 *
 * Single-threaded for the same reason as the integration suite: every file
 * truncates the shared database.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    setupFiles: ["./tests/e2e/setup.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
