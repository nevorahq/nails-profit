import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";

import { bookingSettings, bookings, clients, locations, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { returnDue, type ReturnDue, type ReturnVisit } from "@/domain/client-return";
import { parseContactChannels, type ContactChannelMarks } from "@/domain/contact-channels";
import { formatLocalDate, toZonedParts } from "@/domain/timezone";
import { isPublicBookingEnabled } from "@/env";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-service";

export type ReturnRow = Readonly<{
  clientId: string;
  name: string;
  phone: string | null;
  channels: ContactChannelMarks;
  locale: string | null;
  due: ReturnDue;
}>;

function localDay(instant: Date, timezone: string): string {
  const { year, month, day } = toZonedParts(instant, timezone);
  return formatLocalDate({ year, month, day });
}

/**
 * The clients past their own rhythm, for «Пора позвать» on the clients page.
 *
 * Read in three queries — visits, live clients, appointments still to come —
 * and decided by `returnDue`, which is where the rule lives and is tested. The
 * rhythm is measured across the whole studio even for a Master: a client who
 * went to a colleague last week has not stopped coming. A Master's list is then
 * narrowed to the clients whose latest visit was theirs.
 *
 * Freshly due first: a client a week late is likelier to answer than one gone
 * for a year, and a list worth working through starts with them.
 */
export async function loadReturnList(
  tx: TenantTransaction,
  input: Readonly<{ timezone: string; now: Date; viewerSpecialistId: string | null }>,
): Promise<ReturnRow[]> {
  const visitRows = await tx
    .select({
      clientId: visits.clientId,
      specialistId: visits.specialistId,
      completedAt: visits.completedAt,
    })
    .from(visits)
    .innerJoin(clients, eq(visits.clientId, clients.id))
    .where(and(isNotNull(visits.clientId), isNull(clients.archivedAt), isNull(clients.anonymizedAt)));
  if (visitRows.length === 0) return [];

  const byClient = new Map<string, ReturnVisit[]>();
  for (const row of visitRows) {
    const list = byClient.get(row.clientId!) ?? [];
    list.push({
      day: localDay(row.completedAt, input.timezone),
      completedAt: row.completedAt,
      specialistId: row.specialistId,
    });
    byClient.set(row.clientId!, list);
  }

  const coming = await tx
    .selectDistinct({ clientId: bookings.clientId })
    .from(bookings)
    .where(
      and(
        isNotNull(bookings.clientId),
        inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        gt(bookings.startsAt, input.now),
      ),
    );
  const returning = new Set(coming.map((row) => row.clientId));

  const today = localDay(input.now, input.timezone);
  const dueIds = new Map<string, ReturnDue>();
  for (const [clientId, clientVisits] of byClient) {
    const due = returnDue({
      visits: clientVisits,
      today,
      hasFutureBooking: returning.has(clientId),
      // Archived and erased cards were left out by the join above.
      archived: false,
      viewerSpecialistId: input.viewerSpecialistId ?? undefined,
    });
    if (due) dueIds.set(clientId, due);
  }
  if (dueIds.size === 0) return [];

  const cards = await tx
    .select({
      id: clients.id,
      name: clients.name,
      phone: clients.normalizedPhone,
      channels: clients.contactChannels,
      locale: clients.locale,
    })
    .from(clients)
    .where(inArray(clients.id, [...dueIds.keys()]));

  return cards
    .map((card) => ({
      clientId: card.id,
      name: card.name,
      phone: card.phone,
      channels: parseContactChannels(card.channels),
      locale: card.locale,
      due: dueIds.get(card.id)!,
    }))
    .sort(
      (left, right) =>
        left.due.overdueDays - right.due.overdueDays || left.name.localeCompare(right.name),
    );
}

/**
 * The booking page's slug when it answers, else null.
 *
 * Three conditions, as on the dashboard (`app/app/page.tsx`): the deployment's
 * flag, the studio's rung on the rollout ladder, and an address that is
 * published. A message inviting a client to a 404 is worse than one asking them
 * to write back.
 */
export async function publishedBookingSlug(
  tx: TenantTransaction,
  organization: Readonly<{ slug: string | null; bookingAccess: "off" | "calendar" | "public" }>,
): Promise<string | null> {
  if (!organization.slug || !isPublicBookingEnabled() || organization.bookingAccess !== "public") {
    return null;
  }
  const [published] = await tx
    .select({ id: locations.id })
    .from(locations)
    .innerJoin(bookingSettings, eq(bookingSettings.locationId, locations.id))
    .where(and(eq(locations.status, "active"), eq(bookingSettings.publicStatus, "published")))
    .limit(1);
  return published ? organization.slug : null;
}
