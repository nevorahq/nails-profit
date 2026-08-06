/**
 * What the log says happened, for the technical metrics of roadmap section 7.10
 * that are neither in the database nor about speed: "conflict rate и число
 * отклонённых double-booking попыток", "verification failures и rate-limit
 * blocks", "scheduler failures".
 *
 * Three reports divide section 7.10, and the split is by where the answer lives
 * rather than by taste:
 *
 *   - `ops:booking-metrics` — what the tables know: statuses, queue depth,
 *     the funnel, the overlap invariant;
 *   - `ops:booking-latency` — how long requests took, which only the
 *     `http.timing` lines remember;
 *   - this one — the events that leave no row at all. A refusal writes nothing,
 *     a rate limit that held is precisely the request that did not happen, and
 *     a challenge nobody solved is invisible everywhere else.
 *
 * Latency is deliberately absent here: `booking-latency` owns the percentiles
 * and Gate 7's two targets, and two tools computing one number is how they end
 * up disagreeing in an incident. Timing lines are read only to count attempts,
 * which is the denominator the conflict rate needs.
 */
function criterion(key, label, actual, target, passed) {
  return { key, label, actual, target, passed };
}

function countBy(rows, read) {
  const counts = {};
  for (const row of rows) {
    const key = read(row);
    if (key === undefined || key === null) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000) / 1_000;
}

/** The routes `booking-latency` groups as "booking mutation"; the rate needs the same set. */
const MUTATION_ROUTES = new Set([
  "public.booking.create",
  "public.booking.reschedule",
  "public.booking.cancel",
  "staff.booking.create",
  "staff.booking.reschedule",
]);

/**
 * @param lines parsed log objects, in any order and from any number of files
 */
export function buildLogEventsReport({ lines = [], now = new Date() } = {}) {
  const of = (event) => lines.filter((line) => line.event === event);

  const timings = of("http.timing").filter((line) => typeof line.duration_ms === "number");
  const requestsByRoute = {};
  for (const line of timings) {
    const route = typeof line.route === "string" ? line.route : "unknown";
    const bucket = (requestsByRoute[route] ??= { requests: 0, refused: 0, failed: 0 });
    bucket.requests += 1;
    // A refusal and a failure are different products of the same endpoint: 409
    // is the system working, 500 is not.
    if (line.status >= 400 && line.status < 500) bucket.refused += 1;
    if (line.status >= 500) bucket.failed += 1;
  }

  const mutationAttempts = Object.entries(requestsByRoute)
    .filter(([route]) => MUTATION_ROUTES.has(route))
    .reduce((total, [, bucket]) => total + bucket.requests, 0);

  const conflicts = of("booking.slot_conflict");
  const exclusionViolations = of("booking.exclusion_violation");
  const rateLimits = of("rate_limit.exceeded");
  const challenges = of("security.challenge_required");
  const crossSite = of("security.cross_site_refused");

  const dispatched = of("notification.dispatched").reduce(
    (totals, line) => ({
      claimed: totals.claimed + (line.claimed ?? 0),
      sent: totals.sent + (line.sent ?? 0),
      retried: totals.retried + (line.retried ?? 0),
      dead_lettered: totals.dead_lettered + (line.deadLettered ?? line.dead_lettered ?? 0),
    }),
    { claimed: 0, sent: 0, retried: 0, dead_lettered: 0 },
  );
  const schedulerFailures = of("notification.dispatch_failed").length;

  const criteria = [
    criterion(
      "no_exclusion_violations",
      "Ни одна попытка двойного бронирования не дошла до констрейнта",
      exclusionViolations.length,
      0,
      exclusionViolations.length === 0,
    ),
    criterion(
      "no_scheduler_failures",
      "Джоб рассылки отработал без отказов",
      schedulerFailures,
      0,
      schedulerFailures === 0,
    ),
    criterion(
      "no_server_errors",
      "Ни один booking-запрос не завершился 5xx",
      Object.values(requestsByRoute).reduce((total, bucket) => total + bucket.failed, 0),
      0,
      Object.values(requestsByRoute).every((bucket) => bucket.failed === 0),
    ),
  ];

  return {
    generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    verdict: criteria.every((row) => row.passed) ? "PASS" : "NOT_READY",
    lines_read: lines.length,
    // A count over a file is a count over whatever period that file covers, so
    // the report says which period that was.
    window: { from: earliest(lines), to: latest(lines) },
    requests: requestsByRoute,
    booking: {
      slot_conflicts: conflicts.length,
      /** How often a client loses the race, not how busy the day was. */
      conflict_rate: ratio(conflicts.length, mutationAttempts),
      conflicts_by_operation: countBy(conflicts, (line) => line.operation ?? "unknown"),
      mutation_attempts: mutationAttempts,
      exclusion_violations: exclusionViolations.length,
    },
    abuse: {
      rate_limit_blocks: rateLimits.length,
      rate_limit_by_bucket: countBy(rateLimits, (line) => line.bucket),
      challenges_required: challenges.length,
      challenges_by_verdict: countBy(challenges, (line) => line.verdict),
      cross_site_refusals: crossSite.length,
    },
    notifications: {
      ...dispatched,
      scheduler_failures: schedulerFailures,
      dead_letters_by_code: countBy(of("notification.dead_letter"), (line) => line.code),
    },
    errors: {
      total: of("request.error").length,
      by_route: countBy(of("request.error"), (line) => line.route ?? "unknown"),
    },
    criteria,
  };
}

function timestamps(lines) {
  return lines
    .map((line) => Date.parse(line.timestamp ?? ""))
    .filter((value) => Number.isFinite(value));
}

function earliest(lines) {
  const values = timestamps(lines);
  return values.length === 0 ? null : new Date(Math.min(...values)).toISOString();
}

function latest(lines) {
  const values = timestamps(lines);
  return values.length === 0 ? null : new Date(Math.max(...values)).toISOString();
}

/**
 * Parses a log stream, skipping anything that is not one of our JSON lines.
 *
 * A production log is not only this application: a platform prefixes its own
 * lines, a crash writes a stack trace, and a report that fell over on the first
 * of those would be a report nobody could run during an incident. Skipped lines
 * are counted, never printed — they may carry text from outside our redaction
 * boundary.
 */
export function parseLogLines(text) {
  const parsed = [];
  let skipped = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;

    // A collector may prefix its own container name before our JSON.
    const start = line.indexOf("{");
    if (start === -1) {
      skipped += 1;
      continue;
    }

    try {
      const value = JSON.parse(line.slice(start));
      if (value && typeof value.event === "string") parsed.push(value);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  return { lines: parsed, skipped };
}
