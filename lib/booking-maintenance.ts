import { isNull } from "drizzle-orm";

import { db } from "@/db";
import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  cancelPendingNotifications,
  notifyBooking,
  notifyStaff,
} from "@/lib/booking-notifications";
import { expireUnconfirmedBookings, sweepExpiredHolds } from "@/lib/booking-service";
import { logEvent } from "@/lib/logger";

/**
 * The repair job of sections 7.4 and 7.5, run by the deployment itself.
 *
 * It used to exist only as `scripts/booking-maintenance.mjs`, an operator
 * command the runbook asks to run every minute from somebody's machine — and
 * nothing in the deployment ran it. A request the studio never answered then
 * stayed `pending_confirmation` long past the hour the client was promised an
 * answer by: the slot stayed taken, the client heard nothing, and «Ждут ответа»
 * kept showing a request whose time had run out.
 *
 * So the cron that drains the notification outbox
 * (`.github/workflows/notifications-cron.yml`) calls this
 * first, through the same operator endpoint. Inside `withTenant` and through the
 * application's own notification helpers, which is what the script could not
 * do: it restates the channel rules in SQL, and the two are kept in agreement
 * only by tests. The script stays for an operator who wants a sweep right now,
 * and the two are safe together — each lapses only what is still pending, so
 * whichever comes second finds nothing to tell anybody about.
 */

export type MaintenanceSummary = Readonly<{
  expiredHolds: number;
  lapsedRequests: number;
}>;

export async function runBookingMaintenance(input: {
  organizationId: string;
  now?: Date;
}): Promise<MaintenanceSummary> {
  const now = input.now ?? new Date();
  const { organizationId } = input;

  return withTenant(organizationId, async (tx) => {
    // Requests already expire the holds they trip over; this is for the slots
    // nobody asks about, which would otherwise sit `active` in the table.
    const expiredHolds = await sweepExpiredHolds(tx, now);
    const lapsed = await expireUnconfirmedBookings(tx, now);

    for (const booking of lapsed) {
      // The version the lapse wrote, so the keys match the ones the operator
      // script builds and a request lapsed by both is still told about once.
      const occurrence = String(booking.version);

      // A client told «студия подтвердит» has to hear that it did not.
      await notifyBooking(tx, {
        organizationId,
        bookingId: booking.id,
        template: "booking.cancelled",
        occurrence,
        causedBy: "system",
      });
      // A reminder for an appointment that will not happen.
      await cancelPendingNotifications(tx, booking.id);
      // And the studio, whose list of requests the booking just left.
      await notifyStaff(tx, {
        organizationId,
        bookingId: booking.id,
        template: "booking.staff_request_expired",
        occurrence,
      });
    }

    return { expiredHolds, lapsedRequests: lapsed.length };
  });
}

/**
 * Every live tenant in turn, for the cron.
 *
 * The same shape as `sweepDueNotifications`, and for the same reason: the
 * organization list is readable by the application role, so nothing here needs
 * the operator connection. A tenant that fails is logged and skipped rather
 * than stopping the run for the studios after it.
 */
export async function sweepBookingMaintenance(input?: { now?: Date }): Promise<MaintenanceSummary> {
  const now = input?.now ?? new Date();
  let expiredHolds = 0;
  let lapsedRequests = 0;

  const tenants = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNull(organizations.deletedAt));

  for (const tenant of tenants) {
    try {
      const summary = await runBookingMaintenance({ organizationId: tenant.id, now });
      expiredHolds += summary.expiredHolds;
      lapsedRequests += summary.lapsedRequests;
    } catch (error) {
      logEvent(
        "error",
        "booking.maintenance_failed",
        { organizationId: tenant.id },
        { reason: error instanceof Error ? error.name : "unknown" },
      );
    }
  }

  logEvent("info", "booking.maintenance_completed", {}, {
    expired_holds: expiredHolds,
    lapsed_requests: lapsedRequests,
    source: "cron",
  });

  return { expiredHolds, lapsedRequests };
}
