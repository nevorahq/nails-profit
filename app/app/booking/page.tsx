import { asc, eq, isNull, or, sql } from "drizzle-orm";

import { BookingSetup, type LocationRow, type RotaRule } from "@/components/booking-setup";
import {
  bookings,
  bookingSettings,
  locations,
  services,
  scheduleRules,
  specialistLocations,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { zonedToday } from "@/domain/availability";
import { getTranslator } from "@/i18n/t";
import { alternativeSlots, loadSlotContext } from "@/lib/availability-service";
import { loadMonthGuide } from "@/lib/onboarding";
import { monthOf } from "@/lib/period";
import { requireWorkspace } from "@/lib/workspace";
import type { MemberRole } from "@/domain/rbac";

/**
 * Setting the booking module up, roadmap sections 7.1 and 7.4.
 *
 * The endpoints for locations, booking settings, rotas and specialist
 * assignment have existed since 7.1 and nothing in the interface called them.
 * The effect was a public page that could never be reached by anyone who did
 * not have a terminal: the studio had specialists and services, no address, no
 * working hours, and no way to add either. Everything the pilot ran on was set
 * up with HTTP requests by hand.
 *
 * One page rather than four, because the four things are one task. An address
 * with no hours offers nothing, hours belong to a specialist at an address, and
 * a page nobody published is invisible whichever of them is missing — so the
 * order of the sections is the order the work is actually done in, and each one
 * says what is still missing before a client could book.
 */
/**
 * How far ahead the setup screen looks for a bookable slot. Two weeks: long
 * enough that a studio working two days a week still reads as ready, short
 * enough that "нет свободного времени" means a client would give up rather
 * than scroll.
 */
const SLOT_HORIZON_DAYS = 14;

export default async function BookingSetupPage() {
  const { membership, bookingAccess, locale, organizationSlug, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  /*
   * The rota is step two of «Расчёт месяца», and this is where it is filled in.
   *
   * Owner alone, like the panel and the ledger: the other step is the expense
   * register, which no other role may even read, so for a manager saving hours
   * the window would announce progress towards a list they cannot finish.
   */
  const monthGuide = can(membership.role, "expenses", "read")
    ? await withTenant(membership.organizationId, (tx) =>
        loadMonthGuide(tx, { month: monthOf(new Date()), currency }),
      )
    : null;

  // Reading the setup is the `bookings` read scope; changing it is the
  // organization-wide manage scope, the same split the endpoints enforce.
  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("bookingSetup.noAccess")}</p>
      </main>
    );
  }

  let ownSpecialistId: string | null = null;
  if (membership.role === "master") {
    const [own] = await withTenant(membership.organizationId, (tx) =>
      tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, membership.userId))
        .limit(1),
    );
    ownSpecialistId = own?.id ?? null;
  }

  const data = await withTenant(membership.organizationId, async (tx) => {
    const places = await tx
      .select({
        id: locations.id,
        slug: locations.slug,
        name: locations.name,
        address: locations.address,
        timezone: locations.timezone,
        status: locations.status,
        public_status: bookingSettings.publicStatus,
        slot_step_minutes: bookingSettings.slotStepMinutes,
        min_lead_minutes: bookingSettings.minLeadMinutes,
        max_advance_days: bookingSettings.maxAdvanceDays,
        buffer_before_minutes: bookingSettings.bufferBeforeMinutes,
        buffer_after_minutes: bookingSettings.bufferAfterMinutes,
        confirmation_mode: bookingSettings.confirmationMode,
        confirmation_ttl_minutes: bookingSettings.confirmationTtlMinutes,
        verification_mode: bookingSettings.verificationMode,
        verification_ttl_minutes: bookingSettings.verificationTtlMinutes,
        reminder_lead_minutes: bookingSettings.reminderLeadMinutes,
      })
      .from(locations)
      .leftJoin(bookingSettings, eq(bookingSettings.locationId, locations.id))
      .orderBy(asc(locations.sortOrder), asc(locations.createdAt));

    /*
     * Which addresses a client has already been booked at. The delete endpoint
     * asks the same question before it refuses; asking it here too is what
     * lets the screen stop offering a control that cannot succeed, instead of
     * letting the owner find out by pressing it.
     */
    const booked = new Set(
      (
        await tx
          .selectDistinct({ locationId: bookings.locationId })
          .from(bookings)
      ).map((row) => row.locationId),
    );

    const people = await tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.sortOrder), asc(specialists.createdAt));

    const assignments = await tx
      .select({
        specialist_id: specialistLocations.specialistId,
        location_id: specialistLocations.locationId,
      })
      .from(specialistLocations);

    // Only the rules in force: a closed rule is history, and showing it in an
    // editor that replaces what it shows would invite rewriting the past.
    const rota = await tx
      .select({
        specialist_id: scheduleRules.specialistId,
        location_id: scheduleRules.locationId,
        weekday: scheduleRules.weekday,
        start_minute: scheduleRules.startMinute,
        end_minute: scheduleRules.endMinute,
        effective_from: scheduleRules.effectiveFrom,
      })
      .from(scheduleRules)
      .where(
        or(isNull(scheduleRules.effectiveTo), sql`${scheduleRules.effectiveTo} > current_date`),
      )
      .orderBy(asc(scheduleRules.weekday), asc(scheduleRules.startMinute));

    /*
     * Whether a client could book anything at all in the next two weeks.
     *
     * The checklist above asks whether a rota *exists*; this asks whether it
     * *offers* something, which is the state that reads as "всё настроено, а
     * записаться нельзя". A pattern of two weekdays starting next month, or a
     * lead time longer than the horizon, leaves the page open and empty, and
     * nothing on this screen said so.
     *
     * The shortest service on purpose: if the quickest thing the studio sells
     * does not fit anywhere in a fortnight, nothing does. Computed only when
     * there is a published address and a rota to ask about — before that the
     * blockers already say what is missing, and this would be several queries
     * spent to repeat them.
     */
    const shortest = Math.min(
      ...(await tx
        .select({ minutes: services.durationMinutes })
        .from(services)
        .where(isNull(services.archivedAt))
      )
        .map((row) => row.minutes)
        .filter((minutes): minutes is number => minutes !== null && minutes > 0),
    );

    const publishedPlaces = places.filter(
      (place) => place.status === "active" && place.public_status === "published",
    );
    const askable = Number.isFinite(shortest) && publishedPlaces.length > 0 && rota.length > 0;

    let nearestSlotDate: string | null = null;
    if (askable) {
      const now = new Date();
      outer: for (const place of publishedPlaces) {
        const context = await loadSlotContext(tx, place.id);
        if (!context) continue;
        const today = zonedToday(now, context.timezone);
        for (const person of people) {
          if (!assignments.some((row) => row.location_id === place.id && row.specialist_id === person.id)) {
            continue;
          }
          const nearest = await alternativeSlots(
            tx,
            {
              locationId: place.id,
              specialistId: person.id,
              durationMinutes: shortest,
              date: today,
              now,
            },
            context,
            { limit: 1, horizonDays: SLOT_HORIZON_DAYS },
          );
          if (nearest.length > 0) {
            nearestSlotDate = nearest[0].date;
            break outer;
          }
        }
      }
    }

    return {
      places: places.map((place) => ({ ...place, has_bookings: booked.has(place.id) })),
      people,
      assignments,
      rota,
      slotsChecked: askable,
      nearestSlotDate,
    };
  });

  return (
    <main className="app-shell">
      <BookingSetup
        monthGuide={monthGuide}
        locations={data.places as LocationRow[]}
        specialists={data.people}
        assignments={data.assignments}
        rota={data.rota as RotaRule[]}
        bookingAccess={bookingAccess}
        organizationSlug={organizationSlug}
        canManage={canManageCatalogue(membership.role, "bookings")}
        canPublish={can(membership.role, "organization_settings", "write")}
        canSaveRota={can(membership.role, "bookings", "write")}
        slotsChecked={data.slotsChecked}
        nearestSlotDate={data.nearestSlotDate}
        role={membership.role as MemberRole}
        ownSpecialistId={ownSpecialistId}
        locale={locale}
      />
    </main>
  );
}
