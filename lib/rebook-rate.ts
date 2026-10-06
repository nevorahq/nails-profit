import { and, eq, gte, isNotNull, lte } from "drizzle-orm";

import { bookings, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { rebookRate, type RebookRate } from "@/domain/rebook-rate";
import { studioVisitsOnly, type DashboardFilters } from "@/lib/dashboard";

/**
 * «Записались на следующий раз» over the report's own period and scope.
 *
 * The same filters `loadDashboard` takes, read the same way — the visit's
 * closing time inside the period, narrowed to one master when the report is,
 * a renter's left out when it is not — so the rate and the cards above it are
 * about the same visits. The rule for
 * which of them count lives in `domain/rebook-rate.ts`.
 */
export async function loadRebookRate(tx: TenantTransaction, filters: DashboardFilters): Promise<RebookRate> {
  // One query: each eligible visit beside whatever was booked from it. A list
  // of a year's booking ids sent back as parameters would be the slow half.
  const rows = await tx
    .select({
      bookingId: visits.bookingId,
      rebookedFromBookingId: bookings.rebookedFromBookingId,
      status: bookings.status,
    })
    .from(visits)
    .leftJoin(bookings, eq(bookings.rebookedFromBookingId, visits.bookingId))
    .where(
      and(
        isNotNull(visits.bookingId),
        isNotNull(visits.clientId),
        filters.from ? gte(visits.completedAt, filters.from) : undefined,
        filters.to ? lte(visits.completedAt, filters.to) : undefined,
        filters.specialistId ? eq(visits.specialistId, filters.specialistId) : undefined,
        studioVisitsOnly(filters),
      ),
    );

  return rebookRate(
    rows.map((row) => ({ bookingId: row.bookingId! })),
    rows
      .filter((row) => row.rebookedFromBookingId !== null && row.status !== null)
      .map((row) => ({ rebookedFromBookingId: row.rebookedFromBookingId!, status: row.status! })),
  );
}
