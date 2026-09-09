import { and, count, eq, gte, inArray, isNotNull } from "drizzle-orm";

import { bookings, specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-service";

/**
 * Clients booked with each member of the team from now on.
 *
 * The cost of the «Удалить» button on the team screen. Removing somebody
 * archives their specialist card the moment it is asked and leaves their
 * appointments exactly where they are — which is right, a client's Tuesday
 * does not disappear because the studio parted with somebody — but leaves them
 * with nobody to work them, and nothing wrote to anyone or collected them
 * anywhere. `DELETE /api/v1/specialists/[id]` has counted bookings before
 * archiving all along; the two paths to the same consequence differed only in
 * that one of them counted.
 *
 * Keyed by account rather than by card, because the team screen knows people by
 * the account they signed in with. A card with no account cannot be removed
 * from that screen at all, so it is not counted here.
 */
export async function loadUpcomingByUser(
  tx: TenantTransaction,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ userId: specialists.userId, value: count() })
    .from(bookings)
    .innerJoin(specialists, eq(bookings.specialistId, specialists.id))
    .where(
      and(
        isNotNull(specialists.userId),
        gte(bookings.startsAt, now),
        inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
      ),
    )
    .groupBy(specialists.userId);

  return new Map(rows.map((row) => [row.userId as string, row.value]));
}
