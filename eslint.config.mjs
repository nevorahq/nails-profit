import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  // `.next-playwright` is the browser suite's own build output — `.gitignore`
  // already knows about it, and without it here one CI-mode Playwright run
  // leaves `npm run lint` reporting thirty thousand problems in generated code.
  globalIgnores([
    ".next/**",
    ".next-playwright/**",
    ".netlify/**",
    "coverage/**",
    "drizzle/**",
    "test-results/**",
    "playwright-report/**",
    "next-env.d.ts",
  ]),
  {
    /*
     * Playwright fixtures are not React.
     *
     * A fixture is written as `async ({ page }, use) => { … await use(value) }`
     * — the framework's own shape — and the React rule reads that `use(...)`
     * as the React hook of the same name, called outside a component. There is
     * no React on this side of the process at all; the rule has nothing to say
     * about it, and left on it refuses the only way a fixture can be written.
     */
    files: ["tests/playwright/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
]);
