#!/usr/bin/env node

import { openOperatorConnection } from "./ops-connection.mjs";

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
const dryRun = process.argv.includes("--dry-run");

let sql;
try {
  sql = await openOperatorConnection(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

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
    const [{ windows }] = await sql`
      select count(*)::int as windows from rate_limit_window where window_expires_at <= now() - interval '1 day'
    `;
    line("booking.maintenance_preview", {
      expired_holds: holds,
      lapsed_requests: requests,
      stale_rate_limit_windows: windows,
    });
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
      returning id, organization_id, client_id, specialist_id, version
    `;

    /**
     * A client who was told "the studio will confirm" has to be told that it
     * did not. The same outbox and the same key shape the application writes,
     * so a message queued here is indistinguishable from one queued by a route
     * — including its idempotency, which is what makes running this twice a
     * minute harmless.
     */
    /**
     * The studio's readers, looked up once per organization rather than once
     * per lapsed request. `notifyStaff` asks the same three questions in
     * `lib/booking-notifications.ts`, and they are restated here for the reason
     * the channel rule below the cancellation is: this job writes to the tables
     * directly, and the two must not drift into disagreeing about who hears.
     */
    const studioByOrganization = new Map();

    async function studioReaders(organizationId) {
      const cached = studioByOrganization.get(organizationId);
      if (cached) return cached;

      const [owner] = await sql`
        select user_id from membership
         where organization_id = ${organizationId} and role = 'owner'
         order by created_at
         limit 1
      `;
      const [organization] = await sql`
        select staff_notices from organization where id = ${organizationId}
      `;
      // The front desk only where the studio asked for it; see `staffNoticeAudience`.
      const managers =
        organization?.staff_notices === "owner_and_managers"
          ? await sql`
              select user_id from membership
               where organization_id = ${organizationId} and role = 'manager'
               order by created_at
            `
          : [];

      const readers = {
        ownerUserId: owner?.user_id ?? null,
        managerUserIds: managers.map((row) => row.user_id),
      };
      studioByOrganization.set(organizationId, readers);
      return readers;
    }

    let cancellations = 0;
    let studioMessages = 0;
    for (const booking of lapsed) {
      const queued = await sql`
        insert into notification_outbox
              (organization_id, booking_id, channel, template, idempotency_key, scheduled_at, next_attempt_at)
        select ${booking.organization_id}, ${booking.id}, channel.name::notification_channel, 'booking.cancelled',
               ${booking.id}::text || ':booking.cancelled:' || channel.name || ':' || ${String(booking.version)},
               now(), now()
          from client
          /*
           * The application's own rule, restated in SQL: the address when there
           * is one, the phone only when there is not.
           *
           * This used to queue both, which made it the one place in the product
           * that sent a cancellation by SMS — to every client with a phone,
           * including the ones about to read the same words in their inbox. The
           * comment above promises a message "indistinguishable from one queued
           * by a route", and it was not. See smsReplacesEmail in
           * lib/notification-message.ts for the half of the rule that matters:
           * the client who has no inbox to read anything in.
           *
           * The actor is not checked here because this job is the only writer
           * of cancelled_by = system, and a request nobody answered is news to
           * the client by definition.
           */
          cross join lateral (values
                 ('email', client.email),
                 ('sms', case when client.email is null then client.normalized_phone end))
               as channel(name, destination)
         where client.id = ${booking.client_id}
           and channel.destination is not null
        on conflict do nothing
        returning id
      `;
      cancellations += queued.length;

      // A reminder for an appointment that will not happen.
      await sql`
        delete from notification_outbox
         where booking_id = ${booking.id}
           and template = 'booking.reminder'
           and status in ('pending', 'retry')
      `;

      /*
       * And the studio, which until now learned nothing at all.
       *
       * The client has been told since this job existed. Inside the studio the
       * request simply left the «Ждут ответа» list, and a list something
       * silently leaves reads exactly like a list it was never on: a master
       * back at their phone three hours later cannot tell "I missed one" from
       * "nobody asked". The hour is free again either way, and somebody could
       * still sell it.
       *
       * The line goes in whether or not anyone has an inbox — a card with no
       * account gets no message and its owner still opens the app — which is
       * why it is written before the recipients are even looked up. No actor:
       * the deadline did this, so everybody sees it.
       */
      await sql`
        insert into staff_notice (organization_id, booking_id, kind, specialist_id, actor_user_id)
        values (${booking.organization_id}, ${booking.id}, 'request_expired',
                ${booking.specialist_id}, null)
      `;

      const [card] = await sql`
        select user_id from specialist where id = ${booking.specialist_id}
      `;
      const specialistUserId = card?.user_id ?? null;
      const { ownerUserId, managerUserIds } = await studioReaders(booking.organization_id);

      /*
       * One row per person and never two for one address, which is `notifyStaff`'s
       * rule: a master who is also the owner is written to once, as the master.
       * The occurrence carries the version so a key is unique per row, exactly
       * as the application builds it.
       */
      const readers = [];
      if (specialistUserId) {
        readers.push({ occurrence: String(booking.version), payload: { recipient: "specialist" } });
      }
      for (const userId of managerUserIds) {
        if (userId === specialistUserId || userId === ownerUserId) continue;
        readers.push({
          occurrence: `${booking.version}:manager:${userId}`,
          payload: { recipient: "member", userId },
        });
      }
      if (ownerUserId && ownerUserId !== specialistUserId) {
        readers.push({ occurrence: `${booking.version}:owner`, payload: { recipient: "owner" } });
      }

      for (const reader of readers) {
        const written = await sql`
          insert into notification_outbox
                (organization_id, booking_id, channel, template, idempotency_key, payload,
                 scheduled_at, next_attempt_at)
          values (${booking.organization_id}, ${booking.id}, 'email',
                  'booking.staff_request_expired',
                  ${`${booking.id}:booking.staff_request_expired:email:${reader.occurrence}`},
                  ${sql.json(reader.payload)}, now(), now())
          on conflict do nothing
          returning id
        `;
        studioMessages += written.length;
      }
    }

    // A challenge nobody completed keeps a phone number for no reason; section
    // 7.9 keeps contact data only while it is doing something.
    const verifications = await sql`
      delete from booking_verification where expires_at <= now() - interval '1 day' returning id
    `;

    /*
     * One row per caller the limiter has ever counted. A live window is left
     * alone whatever its age — the row is reset in place when it lapses, so
     * deleting one mid-window would forgive a caller mid-refusal. A day past
     * its end is well beyond the longest rule and means the caller has simply
     * gone away.
     */
    const windows = await sql`
      delete from rate_limit_window where window_expires_at <= now() - interval '1 day' returning bucket_key
    `;

    line("booking.maintenance_completed", {
      expired_holds: holds.length,
      lapsed_requests: lapsed.length,
      queued_cancellations: cancellations,
      queued_studio_notices: studioMessages,
      purged_verifications: verifications.length,
      purged_rate_limit_windows: windows.length,
    });
  }
} finally {
  await sql.end({ timeout: 5 });
}
