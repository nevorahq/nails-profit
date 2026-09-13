import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";

import {
  CalendarBoard,
  type CalendarBooking,
  type CalendarException,
  type CalendarMonthDay,
} from "@/components/calendar-board";
import { ToolIcon } from "@/components/icons";
import { avatarUrl } from "@/domain/avatar-image";
import {
  addOns,
  availabilityExceptions,
  bookingLines,
  bookingSettings,
  bookings,
  clients,
  locations,
  scheduleRules,
  services,
  specialistAvatars,
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
 * A month of dates above, one day's appointments below it. The month is the
 * navigation — a mark per thing standing in a day, so a glance says which dates
 * are full — and the list below is the work: the same card, with the same
 * actions, as the day it belongs to.
 *
 * It replaces a timetable of one column per specialist against an axis of
 * hours. That grid answered "who is with whom at 14:00", which is a question a
 * studio asks about today and never about the 19th, and it answered it in a
 * shape that at 390 px gave each master about fifty pixels of width. What the
 * desk actually reaches for is «когда есть место» — a question about a month,
 * which twelve hours of a single day cannot answer at any width.
 *
 * Every time on the screen is the local time of the location the appointment is
 * at. A studio with two addresses can have them in different zones, and the
 * conversion is done here, on the server, with the location's own IANA name —
 * formatting in the browser would use the viewer's zone and quietly move
 * everyone's Tuesday.
 */

/** How many marks a cell carries before it says «and this many more». */
const MARKS_PER_DAY = 4;

/** The local date an instant falls on, read at the location it happened at. */
function localDateAt(instant: Date, timezone: string) {
  const parts = toZonedParts(instant, timezone);
  return formatLocalDate({ year: parts.year, month: parts.month, day: parts.day });
}

/**
 * The whole ISO weeks a month is drawn in — 35 or 42 days, Monday first.
 *
 * Weeks rather than the month alone, because a grid of seven columns has to
 * begin on a Monday: a February that starts on a Sunday would otherwise put its
 * 1st under «пн». The days either side belong to the neighbouring months and
 * are drawn quieter, but they are real dates and pressing one works — the last
 * days of the outgoing month are exactly what somebody looking at the 1st is
 * most likely to want next.
 */
function monthGrid(anchor: LocalDate): LocalDate[] {
  const first: LocalDate = { year: anchor.year, month: anchor.month, day: 1 };
  const start = addLocalDays(first, 1 - localDateWeekday(first));

  const nextMonth: LocalDate =
    anchor.month === 12
      ? { year: anchor.year + 1, month: 1, day: 1 }
      : { year: anchor.year, month: anchor.month + 1, day: 1 };
  const last = addLocalDays(nextMonth, -1);
  const end = formatLocalDate(addLocalDays(last, 7 - localDateWeekday(last)));

  const days: LocalDate[] = [];
  for (let cursor = start; ; cursor = addLocalDays(cursor, 1)) {
    days.push(cursor);
    if (formatLocalDate(cursor) === end) return days;
  }
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    date?: string;
    location?: string;
    specialist?: string;
    status?: string;
  }>;
}) {
  const { membership, bookingAccess, locale, currency, businessType } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("calendar.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
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
    const grid = monthGrid(anchor);
    const selected = formatLocalDate(anchor);

    // A day either side, because the window is expressed in local dates and the
    // studio's locations need not share a zone: the filtering back to exact
    // local days happens below, once each booking's own zone is known.
    const windowStart = new Date(Date.UTC(grid[0].year, grid[0].month - 1, grid[0].day - 1));
    const windowEnd = new Date(
      Date.UTC(grid.at(-1)!.year, grid.at(-1)!.month - 1, grid.at(-1)!.day + 2),
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

    // Widened in UTC, narrowed back in local time: a booking at 23:00 in one
    // zone belongs to a different local day than the same instant in another.
    const dated = rows.map((row) => ({
      ...row,
      localDate: localDateAt(row.booking.startsAt, row.timezone),
    }));
    const onDay = dated.filter((row) => row.localDate === selected);

    /*
     * The priced-up contents of an appointment, for the listed day alone.
     *
     * A month of dates is drawn from status and start time only — a mark in a
     * cell says nothing about what was booked — so reading every line of every
     * appointment in it would be a month of rows fetched to render nothing. The
     * day below is the half that names services and totals money, and it is one
     * date's worth.
     */
    const lines =
      onDay.length === 0
        ? []
        : await tx
            .select()
            .from(bookingLines)
            .where(
              inArray(
                bookingLines.bookingId,
                onDay.map((row) => row.booking.id),
              ),
            );

    // The photo comes from the card, the way `app/app/visits/page.tsx` reads
    // it: a card nobody has given one has none, and the list falls back to the
    // initial.
    const people = (
      await tx
        .select({
          id: specialists.id,
          name: specialists.name,
          avatarVersion: specialistAvatars.version,
        })
        .from(specialists)
        .leftJoin(specialistAvatars, eq(specialists.id, specialistAvatars.specialistId))
        .where(isNull(specialists.archivedAt))
        .orderBy(asc(specialists.name))
    ).map((person) => ({
      id: person.id,
      name: person.name,
      avatar: avatarUrl(person.id, person.avatarVersion),
    }));

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

    const exceptionsRaw = await tx
      .select({
        id: availabilityExceptions.id,
        specialistId: availabilityExceptions.specialistId,
        locationId: availabilityExceptions.locationId,
        startsAt: availabilityExceptions.startsAt,
        endsAt: availabilityExceptions.endsAt,
        reason: availabilityExceptions.reason,
      })
      .from(availabilityExceptions)
      .where(
        and(
          ownSpecialistId
            ? eq(availabilityExceptions.specialistId, ownSpecialistId)
            : filters.specialist
              ? eq(availabilityExceptions.specialistId, filters.specialist)
              : undefined,
          gte(availabilityExceptions.endsAt, windowStart),
          lt(availabilityExceptions.startsAt, windowEnd),
        ),
      )
      .orderBy(asc(availabilityExceptions.startsAt));

    /*
     * The shifts the day's tally measures its free time against.
     *
     * Without them there is no frame at all: the hours nobody booked would be
     * indistinguishable from the hours a master is not in the studio, and a
     * rota of 10:00–16:00 would be reported as a whole empty day.
     *
     * Read for the whole window and narrowed per day in the component: a rule
     * carries a weekday and a range of dates it applies over, and which of them
     * covers Thursday is a question about the day being listed.
     */
    const shifts = await tx
      .select({
        specialistId: scheduleRules.specialistId,
        locationId: scheduleRules.locationId,
        weekday: scheduleRules.weekday,
        startMinute: scheduleRules.startMinute,
        endMinute: scheduleRules.endMinute,
        effectiveFrom: scheduleRules.effectiveFrom,
        effectiveTo: scheduleRules.effectiveTo,
      })
      .from(scheduleRules)
      .where(
        ownSpecialistId
          ? eq(scheduleRules.specialistId, ownSpecialistId)
          : filters.specialist
            ? eq(scheduleRules.specialistId, filters.specialist)
            : undefined,
      );

    /*
     * And the gap a studio keeps after each appointment. It is not free time —
     * nothing can be booked into it — so counting it as free would offer the
     * desk a ten-minute opening that the booking engine itself refuses.
     */
    const buffers = await tx
      .select({
        locationId: bookingSettings.locationId,
        before: bookingSettings.bufferBeforeMinutes,
        after: bookingSettings.bufferAfterMinutes,
      })
      .from(bookingSettings);

    return {
      shifts,
      buffers,
      dated,
      onDay,
      lines,
      places: active,
      people,
      catalogue,
      extras,
      assignments,
      roster,
      exceptionsRaw,
      anchorZone,
      today: formatLocalDate(today),
      grid,
      anchorMonth: anchor.month,
      selected,
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

  const datedExceptions = data.exceptionsRaw.map((exc) => {
    const timezone = exc.locationId
      ? (data.places.find((place) => place.id === exc.locationId)?.timezone ?? data.anchorZone)
      : data.anchorZone;
    const startParts = toZonedParts(exc.startsAt, timezone);
    const endParts = toZonedParts(exc.endsAt, timezone);
    return {
      id: exc.id,
      localDate: formatLocalDate({
        year: startParts.year,
        month: startParts.month,
        day: startParts.day,
      }),
      startsAt: exc.startsAt.toISOString(),
      localStart: formatLocalTime(startParts.minutes),
      localEnd: formatLocalTime(endParts.minutes),
      timezone,
      specialistId: exc.specialistId,
      specialistName: data.people.find((person) => person.id === exc.specialistId)?.name ?? "",
      locationId: exc.locationId,
      locationName: exc.locationId
        ? (data.places.find((place) => place.id === exc.locationId)?.name ?? null)
        : null,
      reason: exc.reason,
    };
  });

  const exceptions: CalendarException[] = datedExceptions
    .filter((exc) => exc.localDate === data.selected)
    .map(({ startsAt, ...exc }) => {
      void startsAt;
      return exc;
    });

  const calendar: CalendarBooking[] = data.onDay.map((row) => {
    const parts = toZonedParts(row.booking.startsAt, row.timezone);
    const endParts = toZonedParts(row.booking.endsAt, row.timezone);
    const ownLines = data.lines.filter((line) => line.bookingId === row.booking.id);
    const serviceLine = ownLines.find((line) => line.kind === "service");

    return {
      id: row.booking.id,
      localDate: row.localDate,
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
      /* The name this appointment was booked under, then the card it belongs
         to — the same pair the notification list shows, and for the same
         reason: the card is whose history this joins, the snapshot is who is
         coming. */
      clientName: row.booking.clientNameSnapshot ?? row.clientName,
      clientCardName: row.booking.clientNameSnapshot ? row.clientName : null,
      clientPhone: hideContacts ? null : row.clientPhone,
      serviceName: serviceLine
        ? (resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) ?? t("calendar.service"))
        : t("calendar.service"),
      extraLines: Math.max(0, ownLines.length - 1),
      priceMinor: ownLines.reduce((total, line) => total + line.priceMinor, 0),
      confirmationDueAt: row.booking.confirmationDueAt?.toISOString() ?? null,
    };
  });

  /*
   * What each date in the grid carries, as the marks a cell draws.
   *
   * One mark per thing standing in the day — an appointment or a block —
   * ordered the way the day runs, so the colours read left to right in the
   * order they will happen. A cell is about fifty pixels wide on a phone, which
   * is four marks and no more; the rest is a count, because «5 записей» and «15
   * записей» are the same cell otherwise, and which of the two it is decides
   * whether anybody opens it.
   */
  const marks = new Map<string, { at: string; status: string }[]>();
  const mark = (localDate: string, at: string, status: string) => {
    const day = marks.get(localDate);
    if (day) day.push({ at, status });
    else marks.set(localDate, [{ at, status }]);
  };
  for (const row of data.dated) {
    mark(row.localDate, row.booking.startsAt.toISOString(), row.booking.status);
  }
  for (const exc of datedExceptions) mark(exc.localDate, exc.startsAt, "blocked");

  const monthDays: CalendarMonthDay[] = data.grid.map((day) => {
    const date = formatLocalDate(day);
    const entries = (marks.get(date) ?? []).sort((left, right) => left.at.localeCompare(right.at));
    return {
      date,
      outside: day.month !== data.anchorMonth,
      marks: entries.slice(0, MARKS_PER_DAY).map((entry) => entry.status),
      total: entries.length,
    };
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        {/*
          The compose action, on a phone. It lives in the title row rather than
          the toolbar because at 288 a full-width button pushed the month itself
          further down, and it points at the same form the toolbar's button
          does — one place a booking is made, shown in two shapes. Only ever one
          of the two is displayed, so the anchor is not offered twice.

          The condition mirrors the toolbar's: writable, and there is somewhere
          and something to book.
        */}
        {canWrite && data.places.length > 0 && data.catalogue.length > 0 && (
          <a
            className="header-action"
            href="#new-booking"
            aria-label={t("calendar.newBooking")}
            data-label-closed={t("calendar.newBooking")}
            data-label-open={t("calendar.hideNewBooking")}
          >
            <ToolIcon name="plus" />
            <ToolIcon name="minus" />
          </a>
        )}
      </header>

      {moduleOff && <p className="warning-banner">{t("calendar.moduleOff")}</p>}

      <CalendarBoard
        monthDays={monthDays}
        selected={data.selected}
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
        exceptions={exceptions}
        shifts={data.shifts}
        buffers={data.buffers}
        canWrite={canWrite}
        canFilterBySpecialist={scopeFor(membership.role, "bookings") !== "own"}
        businessType={businessType}
        currency={currency}
        localeTag={localeTag(locale)}
        locale={locale}
      />
    </main>
  );
}
