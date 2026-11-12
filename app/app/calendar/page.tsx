import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import {
  CalendarBoard,
  type CalendarBooking,
  type CalendarException,
  type CalendarMonthDay,
  type CalendarVisit,
} from "@/components/calendar-board";
import { avatarUrl, organizationLogoUrl } from "@/domain/avatar-image";
import { keepsManualVisit, manualVisitSpan } from "@/domain/calendar-visits";
import { calendarFrame, sameWindow, type CalendarFrame } from "@/domain/calendar-window";
import {
  addOns,
  availabilityExceptions,
  bookingLines,
  bookingSettings,
  bookings,
  clients,
  financialSnapshots,
  locations,
  scheduleRules,
  serviceAddOns,
  services,
  specialistAvatars,
  specialistLocations,
  specialistServices,
  specialists,
  visitLines,
  visits,
} from "@/db/schema";
import { constantListLiteral, instantLiteral, opaqueIdLiteral, uuidListLiteral, uuidLiteral } from "@/db/literal";
import { readTogether } from "@/db/tenant";
import { can, hasConstraint, scopeFor, seesClientNotes } from "@/domain/rbac";
import { formatLocalDate, formatLocalTime, toZonedParts } from "@/domain/timezone";
import { parseContactChannels } from "@/domain/contact-channels";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { registerOf } from "@/i18n/lexicon";
import { localeTag } from "@/i18n/translate";
import { scopedSpecialistId } from "@/lib/booking-access";
import { loadOrganizationLogoVersion } from "@/lib/organization-logo";
import { requireWorkspace } from "@/lib/workspace";
import { serviceNamesOf } from "@/lib/service-names";

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


export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    date?: string;
    location?: string;
    specialist?: string;
    status?: string;
    /** An appointment to open on arrival; see `focusBookingId`. */
    booking?: string;
  }>;
}) {
  const workspace = await requireWorkspace();
  const { membership, bookingAccess, locale, currency, businessType, organizationName } = workspace;
  const register = registerOf(workspace);
  const t = getTranslator(locale, register);

  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("calendar.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
  const now = new Date();

  /*
   * Everything this page reads, in two rounds of reads that each run at once.
   * It was one transaction and about twenty statements in a row against a
   * database in another region. What the day needs first — the addresses, whose
   * calendar this is, and the lists the forms offer — is asked together; what
   * depends on the window those addresses fix is asked together after it.
   */
  // Started with everything else and awaited after it: the logo is one more
  // read, and not one the page's own reads have to wait behind.
  const logoVersion = loadOrganizationLogoVersion(membership.organizationId);

  const data = await (async () => {
    const firstRead = readTogether(membership.organizationId, {
      /*
       * Inside each read below, the statements are started together and carry
       * no parameters where the value is the code's own (see `db/literal.ts`),
       * so a read's statements reach the database as one flight rather than
       * one after another. The reads themselves still run in transactions of
       * their own, side by side.
       */
      where: async (tx) => {
        const placesRead = tx
          .select({
            id: locations.id,
            name: locations.name,
            timezone: locations.timezone,
            status: locations.status,
          })
          .from(locations)
          .orderBy(asc(locations.sortOrder), asc(locations.name))
          .execute();

        const [places, ownSpecialistId] = await Promise.all([placesRead, scopedSpecialistId(tx, membership)]);
        return { places, ownSpecialistId };
      },
      lists: async (tx) => {
        // The photo comes from the card, the way `app/app/visits/page.tsx` reads
        // it: a card nobody has given one has none, and the list falls back to the
        // initial.
        const peopleRead = tx
          .select({
            id: specialists.id,
            name: specialists.name,
            avatarVersion: specialistAvatars.version,
          })
          .from(specialists)
          .leftJoin(specialistAvatars, eq(specialists.id, specialistAvatars.specialistId))
          .where(isNull(specialists.archivedAt))
          // The studio's own order of its masters, the one `/book` offers them
          // in, so the day's runs and the filter's faces read the same way.
          .orderBy(asc(specialists.sortOrder), asc(specialists.name))
          .execute();

        const catalogueRead = tx
          .select({
            id: services.id,
            name: services.name,
            durationMinutes: services.durationMinutes,
            priceMinor: services.priceMinor,
          })
          .from(services)
          .where(isNull(services.archivedAt))
          .orderBy(asc(services.createdAt))
          .execute();

        const extrasRead = tx
          .select({
            id: addOns.id,
            name: addOns.name,
            priceDeltaMinor: addOns.priceDeltaMinor,
            durationDeltaMinutes: addOns.durationDeltaMinutes,
          })
          .from(addOns)
          .where(isNull(addOns.archivedAt))
          .orderBy(asc(addOns.createdAt))
          .execute();
        // Which services each add-on goes with, so an appointment of two services
        // pairs each add-on with its own. One linked to none stays on offer with
        // any service, which is how this screen always offered it.
        const addOnLinksRead = tx
          .select({ addOnId: serviceAddOns.addOnId, serviceId: serviceAddOns.serviceId })
          .from(serviceAddOns)
          .execute();

        const [peopleRows, catalogue, extras, addOnLinks] = await Promise.all([
          peopleRead,
          catalogueRead,
          extrasRead,
          addOnLinksRead,
        ]);
        const people = peopleRows.map((person) => ({
          id: person.id,
          name: person.name,
          avatar: avatarUrl(person.id, person.avatarVersion),
        }));

        return { people, catalogue, extras, addOnLinks };
      },
      links: async (tx) => {
        const assignmentsRead = tx
          .select({
            specialistId: specialistLocations.specialistId,
            locationId: specialistLocations.locationId,
          })
          .from(specialistLocations)
          .execute();

        // Who does which service, with their own price and length where they have
        // one. A master with no rows here does everything, so the form must be
        // told the rows and not only «which services exist».
        const offersRead = tx
          .select({
            specialistId: specialistServices.specialistId,
            serviceId: specialistServices.serviceId,
            priceMinor: specialistServices.priceOverrideMinor,
            durationMinutes: specialistServices.durationOverrideMinutes,
          })
          .from(specialistServices)
          .execute();

        /*
         * And the gap a studio keeps after each appointment. It is not free time —
         * nothing can be booked into it — so counting it as free would offer the
         * desk a ten-minute opening that the booking engine itself refuses.
         */
        const buffersRead = tx
          .select({
            locationId: bookingSettings.locationId,
            before: bookingSettings.bufferBeforeMinutes,
            after: bookingSettings.bufferAfterMinutes,
            step: bookingSettings.slotStepMinutes,
          })
          .from(bookingSettings)
          .execute();

        /*
         * Written out rather than built, for one word: Drizzle sends `limit` as a
         * parameter, and a parameter costs a second round trip and holds up the
         * flight — this read alone kept the calendar's first round open for an
         * extra two crossings. With the number in the text it goes with the rest.
         */
        const rosterRead = tx
          .execute<{ id: string; name: string; phone: string | null }>(
            sql`select ${clients.id} as id, ${clients.name} as name, ${clients.normalizedPhone} as phone
                from ${clients} where ${clients.archivedAt} is null order by ${clients.name} asc limit 500`,
          )
          .then((rows) => [...rows]);

        const [assignments, offers, buffers, roster] = await Promise.all([
          assignmentsRead,
          offersRead,
          buffersRead,
          rosterRead,
        ]);
        return { assignments, roster, buffers, offers };
      },
    });
    /*
     * The window — which month, which day — and everything read for it, as a
     * function of the zone «today» is read in.
     *
     * The true zone is the address's, and the addresses arrive with the first
     * round. Waiting for them put a whole second round of transactions behind
     * the first: on a database in another region that was the difference
     * between this page and every other. So the second round starts at once,
     * on a guess — the studio's own zone, which is the address's for almost
     * every studio — and the guess is checked when the addresses arrive. Only
     * the day and the month the zone picks are used from it; if either differs
     * (an address in another zone, within hours of its midnight), the window is
     * read again for the right one. A date in the address bar needs no zone, so
     * then the guess is always right.
     */
    const requestedStatuses = (filters.status?.split(",") ?? []).filter(Boolean);
    const frameIn = (zone: string) => calendarFrame(now, zone, filters.date);
    type Frame = CalendarFrame;

    /*
     * Whose rows the calendar is narrowed to: a master's own always, else the
     * one picked in the filter. A master's own card is asked for inside each
     * statement rather than looked up first — the same lookup
     * `scopedSpecialistId` makes, as a subquery — so that the window does not
     * wait for it. Ids are written into the statements rather than sent beside
     * them (see `db/literal.ts`); a filter that is not an id was an error from
     * the database before and is refused before it reaches it now.
     */
    const ownCard =
      scopeFor(membership.role, "bookings") === "own"
        ? sql`(select ${specialists.id} from ${specialists} where ${specialists.userId} = ${opaqueIdLiteral(membership.userId)} limit 1)`
        : null;
    const shownSpecialist = ownCard ?? (filters.specialist ? uuidLiteral(filters.specialist) : null);

    const readWindow = (frame: Frame) =>
      readTogether(membership.organizationId, {
        appointments: async (tx) => {
          const rows = await tx
            .select({
              booking: bookings,
              specialistName: specialists.name,
              locationName: locations.name,
              timezone: locations.timezone,
              clientName: clients.name,
              clientPhone: clients.normalizedPhone,
              clientChannels: clients.contactChannels,
              clientNotes: clients.notes,
            })
            .from(bookings)
            .innerJoin(specialists, eq(bookings.specialistId, specialists.id))
            .innerJoin(locations, eq(bookings.locationId, locations.id))
            .leftJoin(clients, eq(bookings.clientId, clients.id))
            .where(
              and(
                gte(bookings.startsAt, instantLiteral(frame.windowStart)),
                lt(bookings.startsAt, instantLiteral(frame.windowEnd)),
                shownSpecialist ? eq(bookings.specialistId, shownSpecialist) : undefined,
                filters.location ? eq(bookings.locationId, uuidLiteral(filters.location)) : undefined,
                requestedStatuses.length > 0
                  ? inArray(bookings.status, constantListLiteral(requestedStatuses))
                  : undefined,
              ),
            )
            .orderBy(asc(bookings.startsAt));

          // Widened in UTC, narrowed back in local time: a booking at 23:00 in
          // one zone belongs to a different local day than the same instant in
          // another. Each booking carries its own address's zone.
          const dated = rows.map((row) => ({
            ...row,
            localDate: localDateAt(row.booking.startsAt, row.timezone),
          }));
          const onDay = dated.filter((row) => row.localDate === frame.selected);

          /*
           * The priced-up contents of an appointment, for the listed day alone.
           *
           * A month of dates is drawn from status and start time only — a mark
           * in a cell says nothing about what was booked — so reading every line
           * of every appointment in it would be a month of rows fetched to
           * render nothing. The day below is the half that names services and
           * totals money, and it is one date's worth.
           */
          const lines =
            onDay.length === 0
              ? []
              : await tx
                  .select()
                  .from(bookingLines)
                  .where(inArray(bookingLines.bookingId, uuidListLiteral(onDay.map((row) => row.booking.id))));

          return { dated, onDay, lines };
        },
        manual: async (tx) => {
          /*
           * Visits closed by hand, with no appointment behind them — see
           * `domain/calendar-visits`. Scoped exactly as the appointments are.
           * Found by when they were closed and placed by when they began, so the
           * window runs a day longer at its far end: a visit closed just after
           * midnight still belongs to the evening before.
           */
          const visitRows = await tx
            .select({
              id: visits.id,
              specialistId: visits.specialistId,
              specialistName: specialists.name,
              clientName: clients.name,
              completedAt: visits.completedAt,
              plannedDurationMinutes: visits.plannedDurationMinutes,
              actualDurationMinutes: visits.actualDurationMinutes,
            })
            .from(visits)
            .innerJoin(specialists, eq(visits.specialistId, specialists.id))
            .leftJoin(clients, eq(visits.clientId, clients.id))
            .where(
              and(
                isNull(visits.bookingId),
                gte(visits.completedAt, instantLiteral(frame.windowStart)),
                lt(visits.completedAt, instantLiteral(new Date(frame.windowEnd.getTime() + 24 * 60 * 60_000))),
                shownSpecialist ? eq(visits.specialistId, shownSpecialist) : undefined,
              ),
            )
            .orderBy(asc(visits.completedAt));

          /*
           * Names and money for the listed day — read for every visit that could
           * fall on it, before it is known which do.
           *
           * Which day a hand-closed visit belongs to is read in the zone of its
           * address, and the addresses arrive with the other round. Rather than
           * wait for them, this asks for every visit that begins within a day of
           * the selected date in UTC — no zone is further from UTC than that —
           * and the page keeps the ones that land on the day once it knows.
           */
          const dayStart = Date.parse(`${frame.selected}T00:00:00.000Z`);
          const candidateIds = visitRows
            .filter((row) => {
              const startsAt = manualVisitSpan(row).startsAt.getTime();
              return startsAt >= dayStart - 86_400_000 && startsAt < dayStart + 2 * 86_400_000;
            })
            .map((row) => row.id);

          // The newest version of each visit's figures, as `/app/visits` reads
          // it. Asked together: one flight.
          const [handLines, handRevenue] =
            candidateIds.length === 0
              ? [[], []]
              : await Promise.all([
                  tx
                    .select({ visitId: visitLines.visitId, kind: visitLines.kind, nameSnapshot: visitLines.nameSnapshot })
                    .from(visitLines)
                    .where(inArray(visitLines.visitId, uuidListLiteral(candidateIds)))
                    .execute(),
                  tx
                    .selectDistinctOn([financialSnapshots.visitId], {
                      visitId: financialSnapshots.visitId,
                      revenueMinor: financialSnapshots.revenueMinor,
                    })
                    .from(financialSnapshots)
                    .where(inArray(financialSnapshots.visitId, uuidListLiteral(candidateIds)))
                    .orderBy(financialSnapshots.visitId, desc(financialSnapshots.snapshotVersion))
                    .execute(),
                ]);

          return { visitRows, handLines, handRevenue };
        },
        availability: async (tx) => {
          const exceptionsRead = tx
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
                shownSpecialist ? eq(availabilityExceptions.specialistId, shownSpecialist) : undefined,
                gte(availabilityExceptions.endsAt, instantLiteral(frame.windowStart)),
                lt(availabilityExceptions.startsAt, instantLiteral(frame.windowEnd)),
              ),
            )
            .orderBy(asc(availabilityExceptions.startsAt))
            .execute();

          /*
           * The shifts the day's tally measures its free time against.
           *
           * Without them there is no frame at all: the hours nobody booked would
           * be indistinguishable from the hours a master is not in the studio,
           * and a rota of 10:00–16:00 would be reported as a whole empty day.
           *
           * Read for the whole window and narrowed per day in the component: a
           * rule carries a weekday and a range of dates it applies over, and
           * which of them covers Thursday is a question about the day listed.
           */
          const shiftsRead = tx
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
            .where(shownSpecialist ? eq(scheduleRules.specialistId, shownSpecialist) : undefined)
            .execute();

          const [exceptionsRaw, shifts] = await Promise.all([exceptionsRead, shiftsRead]);
          return { exceptionsRaw, shifts };
        },
      });

    const guess = frameIn(workspace.timezone);
    const guessRead = readWindow(guess);
    // Awaited below unless the guess is wrong; a thrown-away read must not
    // surface as an unhandled rejection.
    guessRead.catch(() => {});

    const first = await firstRead;
    const { places, ownSpecialistId } = first.where;
    const { people, catalogue, extras, addOnLinks } = first.lists;
    const { assignments, roster, buffers, offers } = first.links;

    const active = places.filter((place) => place.status === "active");
    // The anchor date is read in the timezone of the location being looked at,
    // so "today" means today where the appointments are.
    const anchorZone =
      active.find((place) => place.id === filters.location)?.timezone ?? active[0]?.timezone ?? "UTC";
    const frame = frameIn(anchorZone);
    const { today, anchor, grid, selected } = frame;
    const second = sameWindow(guess, frame) ? await guessRead : await readWindow(frame);

    const placeIdsOf = (specialistId: string) =>
      assignments
        .filter(
          (link) => link.specialistId === specialistId && active.some((place) => place.id === link.locationId),
        )
        .map((link) => link.locationId);
    const handVisits = second.manual.visitRows
      .filter((row) =>
        keepsManualVisit(
          { specialistLocationIds: placeIdsOf(row.specialistId) },
          { location: filters.location ?? "", statuses: requestedStatuses },
        ),
      )
      .map((row) => {
        const span = manualVisitSpan(row);
        // The visit names no address, so its hours are read in the one being
        // looked at, else its master's, else the calendar's own.
        const place = filters.location || placeIdsOf(row.specialistId)[0];
        const timezone = active.find((candidate) => candidate.id === place)?.timezone ?? anchorZone;
        return { ...row, ...span, timezone, localDate: localDateAt(span.startsAt, timezone) };
      });
    const visitsOnDay = handVisits.filter((row) => row.localDate === selected);
    const onDayIds = new Set(visitsOnDay.map((row) => row.id));
    const handLines = second.manual.handLines.filter((line) => onDayIds.has(line.visitId));
    const handRevenue = second.manual.handRevenue.filter((row) => onDayIds.has(row.visitId));

    const { dated, onDay, lines } = second.appointments;
    const { exceptionsRaw, shifts } = second.availability;

    return {
      shifts,
      buffers,
      handVisits,
      visitsOnDay,
      handLines,
      handRevenue,
      dated,
      onDay,
      lines,
      places: active,
      people,
      catalogue,
      extras,
      addOnLinks,
      assignments,
      offers,
      roster,
      exceptionsRaw,
      anchorZone,
      today: formatLocalDate(today),
      grid,
      anchorMonth: anchor.month,
      selected,
      ownSpecialistId,
    };
  })();

  // Section 6.1: an Analyst reads client history «без телефонов и email». The
  // name stays — a calendar with nobody's name on it is not a calendar.
  const hideContacts = hasConstraint(membership.role, "clients", "exclude_pii");
  const showsNotes = seesClientNotes(membership.role);
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
    const serviceCount = ownLines.filter((line) => line.kind === "service").length;

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
      /* Read with the number and hidden with it: an Analyst has neither. */
      clientChannels: hideContacts ? {} : parseContactChannels(row.clientChannels),
      /* What the studio wrote about them, on the card the master opens before
         the client sits down — withheld wherever the contacts are. */
      clientNotes: showsNotes ? (row.clientNotes ?? null) : null,
      serviceName: serviceNamesOf(ownLines, locale) ?? t("calendar.service"),
      // Add-ons and the like: every service is already in the name.
      extraLines: Math.max(0, ownLines.length - Math.max(1, serviceCount)),
      priceMinor: ownLines.reduce((total, line) => total + line.priceMinor, 0),
      confirmationDueAt: row.booking.confirmationDueAt?.toISOString() ?? null,
    };
  });

  const dayVisits: CalendarVisit[] = data.visitsOnDay.map((visit) => {
    const ownLines = data.handLines.filter((line) => line.visitId === visit.id);
    const serviceCount = ownLines.filter((line) => line.kind === "service").length;
    return {
      id: visit.id,
      localDate: visit.localDate,
      localStart: formatLocalTime(toZonedParts(visit.startsAt, visit.timezone).minutes),
      localEnd: formatLocalTime(toZonedParts(visit.endsAt, visit.timezone).minutes),
      specialistId: visit.specialistId,
      specialistName: visit.specialistName,
      clientName: visit.clientName,
      serviceName: serviceNamesOf(ownLines, locale) ?? t("calendar.service"),
      extraLines: Math.max(0, ownLines.length - Math.max(1, serviceCount)),
      revenueMinor: data.handRevenue.find((row) => row.visitId === visit.id)?.revenueMinor ?? null,
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
  for (const visit of data.handVisits) mark(visit.localDate, visit.startsAt.toISOString(), "visit");
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
      {moduleOff && <p className="warning-banner">{t("calendar.moduleOff")}</p>}

      <CalendarBoard
        monthDays={monthDays}
        selected={data.selected}
        today={data.today}
        now={now.toISOString()}
        bookings={calendar}
        visits={dayVisits}
        locations={data.places}
        specialists={data.people}
        services={data.catalogue.map((service) => ({
          id: service.id,
          name: resolveLocalizedText(service.name, locale, locale) ?? t("calendar.service"),
          durationMinutes: service.durationMinutes,
          priceMinor: service.priceMinor,
        }))}
        offers={data.offers}
        addOns={data.extras.map((addOn) => {
          const linked = data.addOnLinks.filter((link) => link.addOnId === addOn.id).map((link) => link.serviceId);
          return {
            id: addOn.id,
            name: resolveLocalizedText(addOn.name, locale, locale) ?? "",
            priceDeltaMinor: addOn.priceDeltaMinor,
            durationDeltaMinutes: addOn.durationDeltaMinutes,
            serviceIds: linked.length > 0 ? linked : null,
          };
        })}
        assignments={data.assignments}
        focusBookingId={filters.booking ?? null}
        clients={data.roster.map((client) => ({
          id: client.id,
          name: client.name,
          phone: hideContacts ? null : client.phone,
        }))}
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
        studio={{ name: organizationName, logo: organizationLogoUrl(await logoVersion) }}
        businessType={businessType}
        currency={currency}
        localeTag={localeTag(locale)}
        locale={locale}
      />
    </main>
  );
}
