#!/usr/bin/env node

import postgres from "postgres";

/**
 * The repair job section 7.5 asks for: "истёкшие holds освобождаются запросом и
 * периодическим repair job не реже одного раза в минуту".
 *
 * Requests already expire the holds they trip over, which is what keeps a
 * slot bookable the moment someone abandons a form. This exists for the slots
 * nobody asks about: a hold on next Tuesday that nothing touches until next
 * Tuesday would otherwise sit `active` in the table, invisible to the exclusion
 * constraint's predicate and confusing to anyone reading the data.
 *
 * It runs as the migration owner and sweeps every tenant in one statement. That
 * is deliberate: this is operator maintenance, not application code, and giving
 * it a tenant context would mean running it once per organization.
 *
 * Idempotent by construction — it only moves rows whose deadline has passed, so
 * running it twice a minute or once an hour differ in latency, not in effect.
 *
 *   node scripts/booking-maintenance.mjs [--dry-run]
 */
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATION_DATABASE_URL or DATABASE_URL");
  process.exit(2);
}

const dryRun = process.argv.includes("--dry-run");
const sql = postgres(url, { max: 1, prepare: false });

function line(event, fields) {
  // The same one-line JSON the application logs, so one collector reads both.
  console.log(JSON.stringify({ level: "info", event, timestamp: new Date().toISOString(), ...fields }));
}

try {
  if (dryRun) {
    const [{ holds }] = await sql`
      select count(*)::int as holds from booking_hold where status = 'active' and expires_at <= now()
    `;
    const [{ requests }] = await sql`
      select count(*)::int as requests from booking
       where status = 'pending_confirmation' and confirmation_due_at is not null and confirmation_due_at <= now()
    `;
    line("booking.maintenance_preview", { expired_holds: holds, lapsed_requests: requests });
  } else {
    const holds = await sql`
      update booking_hold
         set status = 'expired', updated_at = now()
       where status = 'active' and expires_at <= now()
      returning id
    `;

    // A request the studio never answered stops holding the slot. Cancelled
    // rather than deleted: the client was told it was pending, and the history
    // of that has to survive.
    const lapsed = await sql`
      update booking
         set status = 'cancelled',
             cancelled_at = now(),
             cancelled_by = 'system',
             cancellation_reason = 'confirmation_expired',
             updated_at = now(),
             version = version + 1
       where status = 'pending_confirmation'
         and confirmation_due_at is not null
         and confirmation_due_at <= now()
      returning id
    `;

    line("booking.maintenance_completed", {
      expired_holds: holds.length,
      lapsed_requests: lapsed.length,
    });
  }
} finally {
  await sql.end({ timeout: 5 });
}
