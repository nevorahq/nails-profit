import { and, asc, eq, inArray } from "drizzle-orm";

import { bookingLines, bookings, clients, locations, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { formatLocalDate, formatLocalTime, toZonedParts } from "@/domain/timezone";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { supportedLocales, type AppLocale } from "@/i18n/messages";
import { scopedSpecialistId } from "@/lib/booking-access";
import { bookingModuleRefusal } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * The topbar's notification list: appointments still waiting on the studio,
 * roadmap section 7.2's `pending_confirmation`. A Master sees their own,
 * everyone else with `bookings` access sees the whole studio's — the same
 * split `scopedSpecialistId` already enforces on the calendar itself.
 */
const LIMIT = 20;

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "read")) return apiSuccess([], id);
  // A no-op today — `bookingModuleRefusal` only refuses writes — but this list
  // is calendar-surface data same as `GET /api/v1/bookings`, so it stays
  // reachable to the same rollout gate rather than reading around it.
  const disabled = await bookingModuleRefusal(actor.organizationId, id, "read");
  if (disabled) return disabled;

  const url = new URL(request.url);
  const requestedLocale = url.searchParams.get("locale");
  const locale: AppLocale = (supportedLocales as readonly string[]).includes(requestedLocale ?? "")
    ? (requestedLocale as AppLocale)
    : "ru";

  const rows = await withTenant(actor.organizationId, async (tx) => {
    const ownSpecialistId = await scopedSpecialistId(tx, actor);

    const found = await tx
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
      .where(
        and(
          eq(bookings.status, "pending_confirmation"),
          ownSpecialistId ? eq(bookings.specialistId, ownSpecialistId) : undefined,
        ),
      )
      .orderBy(asc(bookings.startsAt))
      .limit(LIMIT);

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

    return { found, lines };
  });

  const items = rows.found.map((row) => {
    const serviceLine = rows.lines.find(
      (line) => line.bookingId === row.booking.id && line.kind === "service",
    );
    const parts = toZonedParts(row.booking.startsAt, row.timezone);

    return {
      id: row.booking.id,
      specialist_id: row.booking.specialistId,
      specialist_name: row.specialistName,
      client_name: row.clientName,
      service_name: serviceLine ? resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) : null,
      local_date: formatLocalDate({ year: parts.year, month: parts.month, day: parts.day }),
      local_time: formatLocalTime(parts.minutes),
    };
  });

  return apiSuccess(items, id);
}
