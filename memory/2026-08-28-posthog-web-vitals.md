# PostHog `$web_vitals` warning

## Symptom

PostHog Installation Health recommended adding the `$web_vitals` event. No Core Web Vitals events were being observed.

## Root cause

`components/posthog-provider.tsx` initialized `posthog-js` without `capture_performance`. With that option undefined, posthog-js delegates Web Vitals enablement to the project's remote Autocapture setting. If the server-side setting is disabled or has not propagated, the SDK does not start its Web Vitals observers and no `$web_vitals` event is emitted.

The installed SDK (`posthog-js` 1.420.0) supports Web Vitals; PostHog requires only 1.141.2 or newer. The existing key, reverse-proxy host, and UI host are all configured, so the SDK version and basic initialization were not the cause.

## Fix

Set `capture_performance: { web_vitals: true }` in the browser SDK initialization. This makes the application configuration authoritative while preserving the existing analytics-cookie opt-in: events are still dropped until the visitor gives analytics consent.

## Evidence

- Regression test failed before the fix because the `posthog.init` options lacked `capture_performance`.
- After the fix, 65 unit test files / 685 tests pass.
- `npm run typecheck` passes.
- ESLint passes for the provider and its regression test.

## Regression test

`components/posthog-provider.test.ts`

## Operational verification

After deployment, accept analytics cookies, reload a real HTTP(S) page, leave it open for at least five seconds and interact with it so INP can be measured. Confirm `$web_vitals` in PostHog Live Events. PostHog batches available metrics and may wait up to five seconds before sending an event. The project dashboard's Web Vitals Autocapture switch can also remain enabled for consistency, although the client config now explicitly enables capture.

## Status

DONE_WITH_CONCERNS: the application-side cause is fixed and locally verified; final event ingestion requires a deployed browser session and access to the PostHog project.
