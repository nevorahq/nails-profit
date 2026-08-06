/**
 * The Gate 7 dashboard of roadmap section 7.10, computed from rows.
 *
 * Pure for the same reason `pilot-core.mjs` is: the arithmetic behind "95% of
 * notifications reached the provider" and "no two active bookings overlap" is
 * what a gate decision rests on, and it has to be checkable without a database
 * and without a production analytics vendor.
 *
 * Latency is deliberately absent. p50/p95 of a request cannot be recovered from
 * the tables — the application emits `http.timing` lines for the availability
 * and mutation routes, and a collector answers that question. Inventing a
 * latency number here from `created_at` would be inventing it.
 */
function criterion(key, label, actual, target, passed) {
  return { key, label, actual, target, passed };
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000) / 1_000;
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) counts[row[field]] = (counts[row[field]] ?? 0) + 1;
  return counts;
}

/**
 * @param bookings rows of `{ status, source, created_at }`
 * @param holds rows of `{ status }`
 * @param notifications rows of `{ status, template, attempts, next_attempt_at, scheduled_at, sent_at }`
 * @param verifications rows of `{ verified_at, attempts, expires_at }`
 * @param overlaps the count of active bookings sharing a specialist or a chair
 * @param completions `{ completed_bookings, visits_from_bookings }`
 */
export function buildBookingMetricsReport({
  bookings = [],
  holds = [],
  notifications = [],
  verifications = [],
  overlaps = 0,
  completions = { completed_bookings: 0, visits_from_bookings: 0 },
  now = new Date(),
}) {
  const reportTime = asDate(now);

  const byStatus = countBy(bookings, "status");
  const bySource = countBy(bookings, "source");
  const confirmed = byStatus.confirmed ?? 0;
  const completed = byStatus.completed ?? 0;

  const holdsByStatus = countBy(holds, "status");
  const converted = holdsByStatus.converted ?? 0;
  const finishedHolds = converted + (holdsByStatus.expired ?? 0) + (holdsByStatus.released ?? 0);

  const queued = notifications.filter((row) => row.status === "pending" || row.status === "retry");
  const due = queued.filter((row) => asDate(row.next_attempt_at) <= reportTime);
  const sent = notifications.filter((row) => row.status === "sent");
  const deadLetters = notifications.filter((row) => row.status === "dead_letter");
  const finishedMessages = sent.length + deadLetters.length;

  // Job lag: how long the oldest message that should already have gone has been
  // waiting. A scheduler that stops running shows up here and nowhere else.
  const lagSeconds = due.reduce((worst, row) => {
    const waited = (reportTime.getTime() - asDate(row.next_attempt_at).getTime()) / 1_000;
    return Math.max(worst, Math.round(waited));
  }, 0);

  const verified = verifications.filter((row) => row.verified_at !== null);
  const lockedOut = verifications.filter((row) => row.verified_at === null && row.attempts >= 5);
  const abandoned = verifications.filter(
    (row) => row.verified_at === null && row.attempts === 0 && asDate(row.expires_at) <= reportTime,
  );

  const deliveryRate = ratio(sent.length, finishedMessages);
  const criteria = [
    criterion(
      "no_overlapping_bookings",
      "Ни одна пара активных bookings не пересекается у мастера или рабочего места",
      overlaps,
      0,
      overlaps === 0,
    ),
    criterion(
      "bookings_created",
      "Минимум 100 реальных bookings",
      bookings.length,
      100,
      bookings.length >= 100,
    ),
    criterion(
      "bookings_completed",
      "Минимум 30 завершены как visits",
      completions.visits_from_bookings,
      30,
      completions.visits_from_bookings >= 30,
    ),
    criterion(
      "notification_delivery_rate",
      "Минимум 95% transactional-уведомлений переданы provider",
      deliveryRate,
      0.95,
      deliveryRate !== null && deliveryRate >= 0.95,
    ),
    criterion(
      "no_dead_letters",
      "Очередь не копит недоставленные сообщения",
      deadLetters.length,
      0,
      deadLetters.length === 0,
    ),
    criterion(
      "scheduler_keeps_up",
      "Job lag не больше пяти минут",
      lagSeconds,
      300,
      lagSeconds <= 300,
    ),
  ];

  return {
    generated_at: reportTime.toISOString(),
    verdict: criteria.every((row) => row.passed) ? "PASS" : "NOT_READY",
    metrics: {
      bookings_total: bookings.length,
      bookings_by_status: byStatus,
      bookings_by_source: bySource,
      active_bookings: (byStatus.pending_confirmation ?? 0) + confirmed,
      overlapping_active_bookings: overlaps,
      completed_bookings: completed,
      visits_from_bookings: completions.visits_from_bookings,
      booking_to_visit_rate: ratio(completions.visits_from_bookings, completed),
      holds_active: holdsByStatus.active ?? 0,
      holds_expired: holdsByStatus.expired ?? 0,
      hold_conversion_rate: ratio(converted, finishedHolds),
      notifications_queued: queued.length,
      notifications_due: due.length,
      notifications_sent: sent.length,
      notifications_dead_letter: deadLetters.length,
      notification_delivery_rate: deliveryRate,
      notification_job_lag_seconds: lagSeconds,
      notification_retry_backlog: queued.filter((row) => row.status === "retry").length,
      verifications_issued: verifications.length,
      verifications_confirmed: verified.length,
      verification_success_rate: ratio(verified.length, verifications.length),
      verifications_locked_out: lockedOut.length,
      verifications_abandoned: abandoned.length,
    },
    criteria,
  };
}
