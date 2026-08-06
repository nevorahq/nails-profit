#!/usr/bin/env node

import postgres from "postgres";

import { buildBookingMetricsReport } from "./booking-metrics-core.mjs";

/**
 * The operator view of section 7.10, and the half of Gate 7 that can be
 * answered from the database.
 *
 * It runs as the migration owner across every tenant, like the other operator
 * jobs: this is a question about the deployment, not about one organization,
 * and giving it a tenant context would mean running it once per studio.
 *
 * Nothing it selects is PII. Statuses, counts and timestamps answer every
 * criterion here, and a report that had to read a phone number to be produced
 * would be a report nobody could paste into an issue.
 *
 *   node scripts/booking-metrics.mjs [--days 30]
 */
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATION_DATABASE_URL or DATABASE_URL");
  process.exit(2);
}

const daysIndex = process.argv.indexOf("--days");
const days = daysIndex === -1 ? 30 : Number(process.argv[daysIndex + 1]);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error("--days must be an integer between 1 and 365");
  process.exit(2);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  const since = sql`now() - ${`${days} days`}::interval`;

  const [bookings, holds, notifications, verifications, overlapRows, completionRows] =
    await Promise.all([
      sql`select status, source, created_at from booking where created_at >= ${since}`,
      sql`select status from booking_hold where created_at >= ${since}`,
      sql`select status, template, attempts, next_attempt_at, scheduled_at, sent_at,
                 provider_status, provider_event_at
            from notification_outbox where created_at >= ${since}`,
      sql`select verified_at, attempts, expires_at
            from booking_verification where created_at >= ${since}`,
      /**
       * The invariant Gate 7 states outright: "ни одна пара активных bookings
       * не пересекается у одного мастера или рабочего места". The exclusion
       * constraints are supposed to make this impossible — which is exactly why
       * it is worth asking the data rather than trusting the schema.
       */
      sql`
        select count(*)::int as overlaps
          from booking a
          join booking b
            on b.id <> a.id
           and b.organization_id = a.organization_id
           and b.status in ('pending_confirmation', 'confirmed')
           and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(a.starts_at, a.ends_at, '[)')
           and (b.specialist_id = a.specialist_id
                or (a.workplace_id is not null and b.workplace_id = a.workplace_id))
         where a.status in ('pending_confirmation', 'confirmed')
      `,
      sql`
        select
          (select count(*)::int from booking
            where status = 'completed' and created_at >= ${since}) as completed_bookings,
          (select count(*)::int from visit
            where booking_id is not null and created_at >= ${since}) as visits_from_bookings
      `,
    ]);

  const report = buildBookingMetricsReport({
    bookings,
    holds,
    notifications,
    verifications,
    // Each overlapping pair is counted from both sides.
    overlaps: Math.floor(overlapRows[0].overlaps / 2),
    completions: completionRows[0],
  });

  console.log(JSON.stringify({ window_days: days, ...report }, null, 2));
  // A failing gate criterion is a non-zero exit, so this can stand in a check
  // that is supposed to go red rather than in one nobody reads.
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
} finally {
  await sql.end({ timeout: 5 });
}
