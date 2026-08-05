import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Separate from the unit config on purpose: `npm test` must stay fast and need
 * nothing but Node, while these require a migrated PostgreSQL. They also run
 * single-threaded — every test truncates the shared database, so running two at
 * once would have them clearing each other's fixtures.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
