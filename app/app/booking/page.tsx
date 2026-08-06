import { asc, eq, isNull, or, sql } from "drizzle-orm";

import { AppNav } from "@/components/app-nav";
import { BookingSetup, type LocationRow, type RotaRule } from "@/components/booking-setup";
import {
  bookingSettings,
  locations,
  scheduleRules,
  specialistLocations,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

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
export default async function BookingSetupPage() {
  const { membership, organizationName, bookingAccess, locale } = await requireWorkspace();
  const t = getTranslator(locale);

  // Reading the setup is the `bookings` read scope; changing it is the
  // organization-wide manage scope, the same split the endpoints enforce.
  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("bookingSetup.noAccess")}</p>
      </main>
    );
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

    return { places, people, assignments, rota };
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("bookingSetup.title")}</h1>
        </div>
        <AppNav active="/app/booking" locale={locale} />
      </header>

      <BookingSetup
        locations={data.places as LocationRow[]}
        specialists={data.people}
        assignments={data.assignments}
        rota={data.rota as RotaRule[]}
        bookingAccess={bookingAccess}
        canManage={canManageCatalogue(membership.role, "bookings")}
        canPublish={can(membership.role, "organization_settings", "write")}
        locale={locale}
      />
    </main>
  );
}
