#!/usr/bin/env node

import postgres from "postgres";

/**
 * The scheduler section 7.7 asks for: it drains the notification outbox.
 *
 * The split is deliberate. Finding *which* tenants have something due is one
 * SQL statement across every organization, which is work for the migration
 * role; turning a row into a message needs the application's three-language
 * catalogue, the location's timezone and a freshly minted manage link, which is
 * work for the application. So this script asks the database what to drain and
 * asks the application to drain it, over the operator endpoint.
 *
 * Idempotent and interruptible: every message is claimed with `for update skip
 * locked` and carries an idempotency key, so two overlapping runs split the
 * queue instead of double-sending, and a run killed halfway leaves rows that
 * the next run picks up.
 *
 *   OPS_API_TOKEN=… node scripts/notifications.mjs [--dry-run] [--limit 50]
 */
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATION_DATABASE_URL or DATABASE_URL");
  process.exit(2);
}

const token = process.env.OPS_API_TOKEN;
const appUrl = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
const dryRun = process.argv.includes("--dry-run");
const limitIndex = process.argv.indexOf("--limit");
const limit = limitIndex === -1 ? 25 : Number(process.argv[limitIndex + 1]);

if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  console.error("--limit must be an integer between 1 and 100");
  process.exit(2);
}
if (!dryRun && (!token || !appUrl)) {
  console.error("Set OPS_API_TOKEN and APP_URL to send; use --dry-run to inspect the queue");
  process.exit(2);
}

/**
 * A message claimed by a process that then died stays `processing` and would
 * never be looked at again. Its attempt is already spent, so putting it back on
 * the queue cannot loop: after enough restarts it dead-letters like any other
 * exhausted message.
 */
const STALE_PROCESSING_MINUTES = 15;

const sql = postgres(url, { max: 1, prepare: false });

function line(event, fields) {
  console.log(JSON.stringify({ level: "info", event, timestamp: new Date().toISOString(), ...fields }));
}

try {
  if (!dryRun) {
    const requeued = await sql`
      update notification_outbox
         set status = 'retry', updated_at = now()
       where status = 'processing'
         and updated_at <= now() - ${`${STALE_PROCESSING_MINUTES} minutes`}::interval
      returning id
    `;
    if (requeued.length > 0) line("notification.requeued_stalled", { count: requeued.length });
  }

  const due = await sql`
    select organization_id, count(*)::int as due
      from notification_outbox
     where status in ('pending', 'retry')
       and next_attempt_at <= now()
     group by organization_id
     order by due desc
  `;

  if (dryRun) {
    const [{ dead }] = await sql`
      select count(*)::int as dead from notification_outbox where status = 'dead_letter'
    `;
    line("notification.queue_preview", {
      tenants: due.length,
      due: due.reduce((total, row) => total + row.due, 0),
      dead_letters: dead,
    });
  } else {
    let sent = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const tenant of due) {
      const response = await fetch(`${appUrl}/api/v1/ops/notifications`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ organization_id: tenant.organization_id, limit }),
      });

      if (!response.ok) {
        // One tenant's failure is not the others': the loop continues and the
        // next run retries this one, because nothing was consumed.
        line("notification.dispatch_failed", {
          organization_id: tenant.organization_id,
          status: response.status,
        });
        continue;
      }

      const body = await response.json();
      sent += body.data.sent;
      retried += body.data.retried;
      deadLettered += body.data.dead_lettered;
    }

    line("notification.dispatch_completed", {
      tenants: due.length,
      sent,
      retried,
      dead_lettered: deadLettered,
    });
  }
} finally {
  await sql.end({ timeout: 5 });
}
