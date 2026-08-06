/**
 * Types for the latency core, so the end-to-end test that feeds it the log
 * lines a real request produced is checked like the rest of the suite. The
 * module itself stays plain JavaScript for the operator's sake.
 */
export type LatencyCriterion = Readonly<{
  key: string;
  samples: number;
  min_samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  server_errors: number;
  target_p95_ms: number;
  passed: boolean;
}>;

export type BookingLatencyReport = Readonly<{
  generated_at: string;
  verdict: "PASS" | "NOT_READY";
  accepted_samples: number;
  criteria: readonly LatencyCriterion[];
  routes: Record<
    string,
    Readonly<{
      samples: number;
      p50_ms: number | null;
      p95_ms: number | null;
      max_ms: number | null;
      server_errors: number;
    }>
  >;
}>;

export declare function buildBookingLatencyReport(
  records: readonly unknown[],
  options?: { minSamples?: number },
): BookingLatencyReport;
