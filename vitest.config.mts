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
    // lives in tests/integration and has its own config.
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "tests/integration/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
