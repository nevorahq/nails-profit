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

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The funnel of section 7.10: "page viewed → availability searched → booking
 * started → booking confirmed → visit completed".
 *
 * Counted in visits, not in events. Each step is the number of distinct visit
 * keys that reached it, so a client who searched four dates before booking is
 * one visit in both steps — and a studio whose page is opened a hundred times a
 * day is not one `booking_page_viewed` row for all time, which is what these
 * events meant before they carried a visit.
 *
 * The last step is the exception and has to be: completing an appointment is
 * something a member of staff does days later, with no visit around it. It is
 * counted by booking instead, over the bookings that the visits in this window
 * confirmed.
 */
function buildFunnel(events) {
  const sessionsBy = (name) =>
    new Set(
      events
        .filter((row) => row.event_name === name && row.session_key)
        .map((row) => row.session_key),
    );

  const viewed = sessionsBy("booking_page_viewed");
  const searched = sessionsBy("booking_availability_searched");
  const started = sessionsBy("booking_started");
  const confirmed = sessionsBy("booking_confirmed");

  const confirmedBookings = new Set(
    events
      .filter((row) => row.event_name === "booking_confirmed" && row.session_key)
      .map((row) => row.entity_id),
  );
  const completed = events.filter(
    (row) => row.event_name === "booking_completed" && confirmedBookings.has(row.entity_id),
  ).length;

  const steps = [
    { step: "page_viewed", visits: viewed.size },
    { step: "availability_searched", visits: searched.size },
    { step: "booking_started", visits: started.size },
    { step: "booking_confirmed", visits: confirmed.size },
    { step: "visit_completed", visits: completed },
  ];

  return steps.map((entry, index) => ({
    ...entry,
    // Two rates, because they answer different questions: where visits are lost
    // between two screens, and how many of everyone who arrived got an
    // appointment at all.
    from_previous: index === 0 ? null : ratio(entry.visits, steps[index - 1].visits),
    from_start: index === 0 ? null : ratio(entry.visits, steps[0].visits),
  }));
}

/**
 * Gate 7: "клиент завершает mobile booking за медиану ≤2 минут после выбора
 * услуги". Measured per visit, from the first service selection to the
 * confirmation in the same visit.
 *
 * Median rather than average: one client who left the tab open over lunch would
 * move an average and says nothing about the flow.
 */
function timeToBookSeconds(events) {
  const firstSelection = new Map();
  const confirmation = new Map();

  for (const row of events) {
    if (!row.session_key) continue;
    const at = asDate(row.occurred_at).getTime();

    if (row.event_name === "booking_service_selected") {
      const known = firstSelection.get(row.session_key);
      if (known === undefined || at < known) firstSelection.set(row.session_key, at);
    }
    if (row.event_name === "booking_confirmed") {
      const known = confirmation.get(row.session_key);
      if (known === undefined || at > known) confirmation.set(row.session_key, at);
    }
  }

  const durations = [];
  for (const [session, confirmedAt] of confirmation) {
    const selectedAt = firstSelection.get(session);
    if (selectedAt === undefined || confirmedAt < selectedAt) continue;
    durations.push(Math.round((confirmedAt - selectedAt) / 1_000));
  }

  return durations;
}

/**
 * @param bookings rows of `{ status, source, created_at }`
 * @param holds rows of `{ status }`
 * @param notifications rows of `{ status, template, attempts, next_attempt_at, scheduled_at, sent_at, provider_status, provider_event_at }`
 * @param verifications rows of `{ verified_at, attempts, expires_at }`
 * @param overlaps the count of active bookings sharing a specialist or a chair
 * @param completions `{ completed_bookings, visits_from_bookings }`
 */
export function buildBookingMetricsReport({
  bookings = [],
  holds = [],
  notifications = [],
  verifications = [],
  events = [],
  overlaps = 0,
  completions = { completed_bookings: 0, visits_from_bookings: 0 },
  now = new Date(),
}) {
  const reportTime = asDate(now);
  const funnel = buildFunnel(events);
  const timeToBook = timeToBookSeconds(events);
  const medianTimeToBook = median(timeToBook);

  const byStatus = countBy(bookings, "status");
  const bySource = countBy(bookings, "source");
  const confirmed = byStatus.confirmed ?? 0;
  const completed = byStatus.completed ?? 0;

  const holdsByStatus = countBy(holds, "status");
  const converted = holdsByStatus.converted ?? 0;
  const finishedHolds = converted + (holdsByStatus.expired ?? 0) + (holdsByStatus.released ?? 0);

  const queued = notifications.filter(
    (row) => row.status === "pending" || row.status === "retry" || row.status === "processing",
  );
  const due = queued.filter((row) => asDate(row.next_attempt_at) <= reportTime);
  const sent = notifications.filter((row) => row.status === "sent");
  const deadLetters = notifications.filter((row) => row.status === "dead_letter");
  const finishedMessages = sent.length + deadLetters.length;
  const sentWithinTwoMinutes = sent.filter((row) => {
    if (row.sent_at === null || row.sent_at === undefined) return false;
    const elapsed = asDate(row.sent_at).getTime() - asDate(row.scheduled_at).getTime();
    return elapsed >= 0 && elapsed <= 120_000;
  });
  // A message that is still queued after its two-minute delivery window is
  // already a miss. Excluding it until it eventually succeeds or dead-letters
  // would make a stopped scheduler look better precisely while it is stopped.
  const overdueUnfinished = queued.filter(
    (row) => reportTime.getTime() - asDate(row.scheduled_at).getTime() > 120_000,
  );

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

  const providerAcceptanceRate = ratio(sent.length, finishedMessages);
  const providerStatuses = countBy(
    notifications.filter((row) => row.provider_status),
    "provider_status",
  );
  const providerFinished =
    (providerStatuses.delivered ?? 0) +
    (providerStatuses.bounced ?? 0) +
    (providerStatuses.complained ?? 0) +
    (providerStatuses.failed ?? 0) +
    (providerStatuses.suppressed ?? 0);
  const mailServerDeliveryRate = ratio(providerStatuses.delivered ?? 0, providerFinished);
  const onTimeDeliveryRate = ratio(
    sentWithinTwoMinutes.length,
    finishedMessages + overdueUnfinished.length,
  );
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
      "Минимум 95% transactional-уведомлений переданы provider в течение двух минут",
      onTimeDeliveryRate,
      0.95,
      onTimeDeliveryRate !== null && onTimeDeliveryRate >= 0.95,
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
    criterion(
      "time_to_book",
      "Клиент завершает booking за медиану ≤2 минут после выбора услуги",
      medianTimeToBook,
      120,
      medianTimeToBook !== null && medianTimeToBook <= 120,
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
      notifications_overdue_delivery: overdueUnfinished.length,
      notifications_sent: sent.length,
      notifications_sent_within_two_minutes: sentWithinTwoMinutes.length,
      notifications_dead_letter: deadLetters.length,
      notification_provider_acceptance_rate: providerAcceptanceRate,
      notification_provider_statuses: providerStatuses,
      notification_mail_server_delivery_rate: mailServerDeliveryRate,
      notification_delivery_rate: onTimeDeliveryRate,
      notification_job_lag_seconds: lagSeconds,
      notification_retry_backlog: queued.filter((row) => row.status === "retry").length,
      verifications_issued: verifications.length,
      verifications_confirmed: verified.length,
      verification_success_rate: ratio(verified.length, verifications.length),
      verifications_locked_out: lockedOut.length,
      verifications_abandoned: abandoned.length,
      booking_visits: funnel[0].visits,
      booking_conversion_rate: funnel[3].from_start,
      time_to_book_median_seconds: medianTimeToBook,
      time_to_book_samples: timeToBook.length,
    },
    funnel,
    criteria,
  };
}
