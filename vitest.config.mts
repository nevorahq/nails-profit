import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Unit tests must run with nothing but Node. Anything needing PostgreSQL
    // lives in tests/integration or tests/e2e and has its own config.
    include: ["**/*.test.ts", "**/*.test.mjs"],
    exclude: ["node_modules/**", ".next/**", "tests/integration/**", "tests/e2e/**"],
    coverage: {
      include: ["domain/**/*.ts"],
      exclude: ["domain/**/*.test.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
