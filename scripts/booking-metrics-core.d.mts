/**
 * Types for the pilot metrics core, so the one thing the application needs to
 * know about it is checked like the rest of the suite.
 *
 * The module itself stays plain JavaScript, like every other operator core
 * here: it has to run under `node scripts/…` with nothing installed and no
 * build step, because a report an operator cannot run during an incident is
 * not a report.
 *
 * Only what a TypeScript caller actually reaches for is declared. The report
 * itself is read by `scripts/booking-metrics.mjs` and by its own `.mjs` test,
 * neither of which is type-checked, and describing its forty fields here would
 * be a second definition to keep true rather than a guarantee.
 */

/**
 * How long a message may sit without the provider saying what became of it
 * before that silence is itself the finding. Pinned to `POLL_WINDOW_HOURS` in
 * `lib/smsmd-delivery-status.ts` by a test, because the report counts exactly
 * the rows that poll gave up on.
 */
export declare const PROVIDER_CONFIRMATION_WINDOW_HOURS: number;

export declare function buildBookingMetricsReport(input?: Record<string, unknown>): {
  generated_at: string;
  verdict: "PASS" | "NOT_READY";
  metrics: Record<string, unknown>;
  funnel: readonly Record<string, unknown>[];
  criteria: readonly Readonly<{
    key: string;
    label: string;
    actual: number | null;
    target: number;
    passed: boolean;
  }>[];
};
