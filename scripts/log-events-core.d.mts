/**
 * Types for the operator core, so the end-to-end test that feeds it real log
 * lines is checked like the rest of the suite.
 *
 * The module itself stays plain JavaScript, like every other operator core
 * here: it has to run under `node scripts/…` with nothing installed and no
 * build step, because a report an operator cannot run during an incident is
 * not a report.
 */
export type LogLine = Readonly<Record<string, unknown>> & { event: string };

export type LogEventsReport = Readonly<{
  generated_at: string;
  verdict: "PASS" | "NOT_READY";
  lines_read: number;
  window: Readonly<{ from: string | null; to: string | null }>;
  requests: Record<string, { requests: number; refused: number; failed: number }>;
  booking: Readonly<{
    slot_conflicts: number;
    conflict_rate: number | null;
    conflicts_by_operation: Record<string, number>;
    mutation_attempts: number;
    exclusion_violations: number;
  }>;
  abuse: Readonly<{
    rate_limit_blocks: number;
    rate_limit_by_bucket: Record<string, number>;
    challenges_required: number;
    challenges_by_verdict: Record<string, number>;
    cross_site_refusals: number;
  }>;
  notifications: Readonly<{
    claimed: number;
    sent: number;
    retried: number;
    dead_lettered: number;
    scheduler_failures: number;
    dead_letters_by_code: Record<string, number>;
  }>;
  errors: Readonly<{ total: number; by_route: Record<string, number> }>;
  criteria: readonly Readonly<{
    key: string;
    label: string;
    actual: number | null;
    target: number;
    passed: boolean;
  }>[];
}>;

export declare function parseLogLines(text: string): { lines: LogLine[]; skipped: number };

export declare function buildLogEventsReport(input?: {
  lines?: readonly LogLine[];
  now?: Date;
}): LogEventsReport;
