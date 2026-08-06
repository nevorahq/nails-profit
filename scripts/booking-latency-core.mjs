const ROUTE_GROUPS = {
  availability: {
    routes: new Set(["public.availability"]),
    p95TargetMs: 500,
  },
  booking_mutation: {
    routes: new Set([
      "public.booking.create",
      "public.booking.reschedule",
      "public.booking.cancel",
      "staff.booking.create",
      "staff.booking.reschedule",
    ]),
    p95TargetMs: 800,
  },
};

const KNOWN_ROUTES = new Set(
  Object.values(ROUTE_GROUPS).flatMap(({ routes }) => [...routes]),
);

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function stats(samples) {
  const durations = samples.map((sample) => sample.duration_ms);
  return {
    samples: samples.length,
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    max_ms: durations.length === 0 ? null : Math.max(...durations),
    server_errors: samples.filter((sample) => sample.status >= 500).length,
  };
}

/**
 * Builds the fleet-level latency half of roadmap Gate 7 from collected
 * `http.timing` log records. The database metrics script intentionally cannot
 * answer this question: request duration only exists while the request runs.
 */
export function buildBookingLatencyReport(records, { minSamples = 30 } = {}) {
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error("minSamples must be a positive integer");
  }

  const samples = records.filter(
    (record) =>
      record !== null &&
      typeof record === "object" &&
      record.event === "http.timing" &&
      KNOWN_ROUTES.has(record.route) &&
      Number.isFinite(record.duration_ms) &&
      record.duration_ms >= 0 &&
      Number.isInteger(record.status) &&
      record.status >= 100 &&
      record.status <= 599,
  );

  const perRoute = Object.fromEntries(
    [...KNOWN_ROUTES].map((route) => [
      route,
      stats(samples.filter((sample) => sample.route === route)),
    ]),
  );

  const criteria = Object.entries(ROUTE_GROUPS).map(([key, definition]) => {
    const result = stats(samples.filter((sample) => definition.routes.has(sample.route)));
    const enoughSamples = result.samples >= minSamples;
    const withinTarget = result.p95_ms !== null && result.p95_ms <= definition.p95TargetMs;
    return {
      key,
      samples: result.samples,
      min_samples: minSamples,
      p50_ms: result.p50_ms,
      p95_ms: result.p95_ms,
      max_ms: result.max_ms,
      server_errors: result.server_errors,
      target_p95_ms: definition.p95TargetMs,
      passed: enoughSamples && withinTarget,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    verdict: criteria.every((criterion) => criterion.passed) ? "PASS" : "NOT_READY",
    accepted_samples: samples.length,
    criteria,
    routes: perRoute,
  };
}

