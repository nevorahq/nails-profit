import { defineConfig, devices } from "@playwright/test";

import { configureTestDatabase } from "./tests/test-database-env";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const port = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
const localBaseUrl = `http://127.0.0.1:${port}`;
const baseURL = externalBaseUrl ?? localBaseUrl;

// A locally started browser suite may create accounts and organizations. Keep
// it on the destructive _test database, protected by the same checks as the
// existing integration suites. A supplied URL is treated as an external target
// and is never paired with local database configuration.
if (!externalBaseUrl) {
  // Playwright loads this config again in worker processes. Those workers
  // inherit the already-switched DATABASE_URL, so treat an explicitly named
  // _test URL as idempotent instead of mistaking it for the development URL.
  if (
    process.env.DATABASE_URL === process.env.TEST_DATABASE_URL &&
    process.env.TEST_DATABASE_URL &&
    new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  ) {
    process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
  } else {
    configureTestDatabase();
  }
}

export default defineConfig({
  testDir: "./tests/playwright",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/playwright",
  use: {
    baseURL,
    locale: "en-US",
    // Playwright 1.62 takes this through `contextOptions`; written directly on
    // `use` it fails the type check, which fails `next build` with it.
    contextOptions: { reducedMotion: "reduce" },
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  expect: { timeout: 10_000 },
  timeout: 45_000,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: process.env.CI
          ? `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`
          : `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
        url: localBaseUrl,
        reuseExistingServer: !process.env.CI,
        timeout: process.env.CI ? 180_000 : 120_000,
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL!,
          MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL!,
          BETTER_AUTH_URL: localBaseUrl,
          NEXT_PUBLIC_APP_URL: localBaseUrl,
          NEXT_DIST_DIR: ".next-playwright",
          PILOT_ACCESS_ENFORCEMENT: "false",
          SUBSCRIPTION_ACCESS_ENFORCEMENT: "false",
          // Every scenario registers its own owner and master through the real
          // sign-up endpoint, which production limits to five an hour. The
          // server only honours this while it is pointed at a `_test` database
          // — see `relaxedForBrowserTests` in `lib/auth.ts`.
          AUTH_RATE_LIMIT: "off",
          // The browser suite tests the product a client books through, so the
          // public flow is part of what is under test rather than something the
          // surrounding environment gets to switch off: a staff-made
          // appointment is confirmed on creation, and «запрос, ожидающий
          // ответа» — the state half these scenarios start from — can only come
          // from the public page.
          PUBLIC_BOOKING_ENABLED: "true",
          // Sign-up mails a verification link. A production build would hand it
          // to the real provider; the browser suite has no business sending
          // mail to anyone, so it is written to the log instead.
          NOTIFICATION_PROVIDER: "log",
        },
      },
});
