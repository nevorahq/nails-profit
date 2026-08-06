import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";

import { AppNav } from "@/components/app-nav";
import { CalendarBoard, type CalendarBooking, type CalendarView } from "@/components/calendar-board";
import {
  addOns,
  bookingLines,
  bookings,
  clients,
  locations,
  services,
  specialistLocations,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, hasConstraint, scopeFor } from "@/domain/rbac";
import {
  addLocalDays,
  formatLocalDate,
  formatLocalTime,
  localDateWeekday,
  parseLocalDate,
  toZonedParts,
  type LocalDate,
} from "@/domain/timezone";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { scopedSpecialistId } from "@/lib/booking-access";
import { requireWorkspace } from "@/lib/workspace";

/**
 * The staff calendar, roadmap section 7.2.
 *
 * Three views rather than a grid of hours: at 360 px a column-per-specialist
 * timetable is unreadable, and section 7.8 asks for the mobile width to work
 * rather than to be tolerated. A day is a list per specialist, a week is a list
 * per day, and the flat list is what a receptionist searches in.
 *
 * Every time on the screen is the local time of the location the appointment is
 * at. A studio with two addresses can have them in different zones, and the
 * conversion is done here, on the server, with the location's own IANA name —
 * formatting in the browser would use the viewer's zone and quietly move
 * everyone's Tuesday.
 */
const VIEWS: readonly CalendarView[] = ["day", "week", "list"];

/** How many local days each view covers, starting from its first day. */
const SPAN: Readonly<Record<CalendarView, number>> = { day: 1, week: 7, list: 14 };

function firstDayOf(view: CalendarView, anchor: LocalDate): LocalDate {
  if (view !== "week") return anchor;
  // ISO weeks start on Monday, which is what a rota is written in.
  return addLocalDays(anchor, 1 - localDateWeekday(anchor));
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    date?: string;
    location?: string;
    specialist?: string;
    status?: string;
  }>;
}) {
  const { membership, organizationName, bookingAccess, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("calendar.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
  const view: CalendarView = VIEWS.includes(filters.view as CalendarView)
    ? (filters.view as CalendarView)
    : "day";

  const now = new Date();

  const data = await withTenant(membership.organizationId, async (tx) => {
    const places = await tx
      .select({
        id: locations.id,
        name: locations.name,
        timezone: locations.timezone,
        status: locations.status,
      })
      .from(locations)
      .orderBy(asc(locations.sortOrder), asc(locations.name));

    const active = places.filter((place) => place.status === "active");
    // The anchor date is read in the timezone of the location being looked at,
    // so "today" means today where the appointments are.
    const anchorZone =
      active.find((place) => place.id === filters.location)?.timezone ?? active[0]?.timezone ?? "UTC";
    const todayParts = toZonedParts(now, anchorZone);
    const today: LocalDate = { year: todayParts.year, month: todayParts.month, day: todayParts.day };
    const anchor = (filters.date ? parseLocalDate(filters.date) : null) ?? today;
    const from = firstDayOf(view, anchor);
    const days = Array.from({ length: SPAN[view] }, (_, index) => addLocalDays(from, index));
    const dayKeys = new Set(days.map(formatLocalDate));

    // A day either side, because the window is expressed in local dates and the
    // studio's locations need not share a zone: the filtering back to exact
    // local days happens below, once each booking's own zone is known.
    const windowStart = new Date(Date.UTC(from.year, from.month - 1, from.day - 1));
    const windowEnd = new Date(
      Date.UTC(days.at(-1)!.year, days.at(-1)!.month - 1, days.at(-1)!.day + 2),
    );

    const ownSpecialistId = await scopedSpecialistId(tx, membership);
    const requestedStatuses = (filters.status?.split(",") ?? []).filter(Boolean);

    const rows = await tx
      .select({
        booking: bookings,
        specialistName: specialists.name,
        locationName: locations.name,
        timezone: locations.timezone,
        clientName: clients.name,
        clientPhone: clients.normalizedPhone,
      })
      .from(bookings)
      .innerJoin(specialists, eq(bookings.specialistId, specialists.id))
      .innerJoin(locations, eq(bookings.locationId, locations.id))
      .leftJoin(clients, eq(bookings.clientId, clients.id))
      .where(
        and(
          gte(bookings.startsAt, windowStart),
          lt(bookings.startsAt, windowEnd),
          ownSpecialistId
            ? eq(bookings.specialistId, ownSpecialistId)
            : filters.specialist
              ? eq(bookings.specialistId, filters.specialist)
              : undefined,
          filters.location ? eq(bookings.locationId, filters.location) : undefined,
          requestedStatuses.length > 0
            ? inArray(bookings.status, requestedStatuses as (typeof bookings.$inferSelect)["status"][])
            : undefined,
        ),
      )
      .orderBy(asc(bookings.startsAt));

    const lines =
      rows.length === 0
        ? []
        : await tx
            .select()
            .from(bookingLines)
            .where(
              inArray(
                bookingLines.bookingId,
                rows.map((row) => row.booking.id),
              ),
            );

    const people = await tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.name));

    const catalogue = await tx
      .select({ id: services.id, name: services.name, durationMinutes: services.durationMinutes })
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    const extras = await tx
      .select({ id: addOns.id, name: addOns.name })
      .from(addOns)
      .where(isNull(addOns.archivedAt))
      .orderBy(asc(addOns.createdAt));

    const assignments = await tx
      .select({
        specialistId: specialistLocations.specialistId,
        locationId: specialistLocations.locationId,
      })
      .from(specialistLocations);

    const roster = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(isNull(clients.archivedAt))
      .orderBy(asc(clients.name))
      .limit(500);

    return {
      rows,
      lines,
      places: active,
      people,
      catalogue,
      extras,
      assignments,
      roster,
      today: formatLocalDate(today),
      days: days.map(formatLocalDate),
      dayKeys,
      ownSpecialistId,
    };
  });

  // Section 6.1: an Analyst reads client history «без телефонов и email». The
  // name stays — a calendar with nobody's name on it is not a calendar.
  const hideContacts = hasConstraint(membership.role, "clients", "exclude_pii");
  // Section 7.11's rollback state, and section 7's rollback list is exact about
  // what survives it: the appointments already made stay visible to staff in
  // read-only mode. The module stops taking work; the day still has to be
  // legible to whoever is standing at the desk when it is switched off.
  const moduleOff = bookingAccess === "off";
  const canWrite = can(membership.role, "bookings", "write") && !moduleOff;

  const calendar: CalendarBooking[] = data.rows
    .map((row) => {
      const parts = toZonedParts(row.booking.startsAt, row.timezone);
      const endParts = toZonedParts(row.booking.endsAt, row.timezone);
      const ownLines = data.lines.filter((line) => line.bookingId === row.booking.id);
      const serviceLine = ownLines.find((line) => line.kind === "service");

      return {
        id: row.booking.id,
        localDate: formatLocalDate({ year: parts.year, month: parts.month, day: parts.day }),
        startsAt: row.booking.startsAt.toISOString(),
        endsAt: row.booking.endsAt.toISOString(),
        localStart: formatLocalTime(parts.minutes),
        localEnd: formatLocalTime(endParts.minutes),
        timezone: row.timezone,
        status: row.booking.status,
        version: row.booking.version,
        specialistId: row.booking.specialistId,
        specialistName: row.specialistName,
        locationId: row.booking.locationId,
        locationName: row.locationName,
        clientId: row.booking.clientId,
        clientName: row.clientName,
        clientPhone: hideContacts ? null : row.clientPhone,
        serviceName: serviceLine
          ? (resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) ?? t("calendar.service"))
          : t("calendar.service"),
        extraLines: Math.max(0, ownLines.length - 1),
        priceMinor: ownLines.reduce((total, line) => total + line.priceMinor, 0),
        confirmationDueAt: row.booking.confirmationDueAt?.toISOString() ?? null,
      };
    })
    // Widened in UTC, narrowed back in local time: a booking at 23:00 in one
    // zone belongs to a different local day than the same instant in another.
    .filter((booking) => data.dayKeys.has(booking.localDate));

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("calendar.title")}</h1>
        </div>
        <AppNav active="/app/calendar" locale={locale} />
      </header>

      {moduleOff && <p className="warning-banner">{t("calendar.moduleOff")}</p>}

      <CalendarBoard
        view={view}
        days={data.days}
        today={data.today}
        bookings={calendar}
        locations={data.places}
        specialists={data.people}
        services={data.catalogue.map((service) => ({
          id: service.id,
          name: resolveLocalizedText(service.name, locale, locale) ?? t("calendar.service"),
          durationMinutes: service.durationMinutes,
        }))}
        addOns={data.extras.map((addOn) => ({
          id: addOn.id,
          name: resolveLocalizedText(addOn.name, locale, locale) ?? "",
        }))}
        assignments={data.assignments}
        clients={data.roster}
        filters={{
          location: filters.location ?? "",
          specialist: filters.specialist ?? "",
          status: filters.status ?? "",
        }}
        ownSpecialistId={data.ownSpecialistId}
        canWrite={canWrite}
        canFilterBySpecialist={scopeFor(membership.role, "bookings") !== "own"}
        currency={currency}
        localeTag={localeTag(locale)}
        locale={locale}
      />
    </main>
  );
}
