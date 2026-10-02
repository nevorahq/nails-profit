import { and, asc, countDistinct, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { bookingLines, bookings, clients, locations, specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { formatLocalDate, formatLocalTime, toZonedParts } from "@/domain/timezone";
import type { AppLocale } from "@/i18n/messages";
import { scopedSpecialistId, type CalendarActor } from "@/lib/booking-access";
import { serviceNamesOf } from "@/lib/service-names";

/**
 * Appointments that happened and were never closed into a visit.
 *
 * Every figure in the product is counted from visits, and a confirmed booking
 * becomes one only when somebody presses «Завершить в визит». Nothing used to
 * say when that was forgotten: the appointment sat confirmed in the past, its
 * money in no report, and the month read lower than the studio's notebook with
 * no line explaining the difference.
 *
 * Listed rather than closed automatically. A visit records money taken; an
 * appointment that ended records only that the time passed — the client may
 * not have come, or may have paid something else. Inventing the revenue would
 * be worse than missing it, so the product asks.
 *
 * `ends_at` rather than `starts_at`: an appointment in progress is not
 * forgotten yet, it is being worked.
 */

export type UnclosedBooking = Readonly<{
  id: string;
  version: number;
  specialistId: string;
  specialistName: string;
  clientName: string | null;
  serviceName: string | null;
  localDate: string;
  localTime: string;
  /** The booking's «Итого» — what closing it as it stands would record. */
  priceMinor: number;
}>;

export type UnclosedBookings = Readonly<{
  items: readonly UnclosedBooking[];
  /** All of them, not only the ones listed. */
  count: number;
  totalMinor: number;
}>;

export async function loadUnclosedBookings(
  tx: TenantTransaction,
  actor: CalendarActor,
  options: Readonly<{
    now: Date;
    locale: AppLocale;
    limit?: number;
    /** Narrows to appointments that ended inside a period, as a report asks. */
    endedFrom?: Date;
    endedTo?: Date;
  }>,
): Promise<UnclosedBookings> {
  // A master sees their own, as everywhere in the calendar.
  const own = await scopedSpecialistId(tx, actor);
  const latest = options.endedTo && options.endedTo < options.now ? options.endedTo : options.now;

  const where = and(
    eq(bookings.status, "confirmed"),
    lte(bookings.endsAt, latest),
    options.endedFrom ? gte(bookings.endsAt, options.endedFrom) : undefined,
    own ? eq(bookings.specialistId, own) : undefined,
  );

  const [totals] = await tx
    .select({
      count: countDistinct(bookings.id),
      total: sql<string>`coalesce(sum(${bookingLines.priceMinor}), 0)`,
    })
    .from(bookings)
    .leftJoin(bookingLines, eq(bookingLines.bookingId, bookings.id))
    .where(where);

  const count = Number(totals?.count ?? 0);
  if (count === 0) return { items: [], count: 0, totalMinor: 0 };

  const limit = options.limit ?? 0;
  const found =
    limit > 0
      ? await tx
          .select({
            booking: bookings,
            specialistName: specialists.name,
            clientName: clients.name,
            timezone: locations.timezone,
          })
          .from(bookings)
          .innerJoin(specialists, eq(bookings.specialistId, specialists.id))
          .innerJoin(locations, eq(bookings.locationId, locations.id))
          .leftJoin(clients, eq(bookings.clientId, clients.id))
          .where(where)
          // Oldest first: the one most likely to be forgotten for good.
          .orderBy(asc(bookings.startsAt))
          .limit(limit)
      : [];

  const lines =
    found.length === 0
      ? []
      : await tx
          .select()
          .from(bookingLines)
          .where(
            inArray(
              bookingLines.bookingId,
              found.map((row) => row.booking.id),
            ),
          );

  const items = found.map((row) => {
    const itsLines = lines.filter((line) => line.bookingId === row.booking.id);
    const parts = toZonedParts(row.booking.startsAt, row.timezone);
    return {
      id: row.booking.id,
      version: row.booking.version,
      specialistId: row.booking.specialistId,
      specialistName: row.specialistName,
      // The name the appointment was made under, as the bell shows it.
      clientName: row.booking.clientNameSnapshot ?? row.clientName,
      serviceName: serviceNamesOf(itsLines, options.locale),
      localDate: formatLocalDate({ year: parts.year, month: parts.month, day: parts.day }),
      localTime: formatLocalTime(parts.minutes),
      priceMinor: itsLines.reduce((total, line) => total + line.priceMinor, 0),
    };
  });

  return { items, count, totalMinor: Number(totals?.total ?? 0) };
}
