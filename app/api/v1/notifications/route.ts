import { and, asc, eq, inArray } from "drizzle-orm";

import { bookingLines, bookings, clients, locations, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { formatLocalDate, formatLocalTime, toZonedParts } from "@/domain/timezone";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { supportedLocales, type AppLocale } from "@/i18n/messages";
import { scopedSpecialistId } from "@/lib/booking-access";
import { groupNotices, loadNoticeFeed, noticesReadAt } from "@/lib/staff-notices";
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
  if (!can(actor.role, "bookings", "read")) {
    return apiSuccess({ pending: [], feed: [], unread: 0 }, id);
  }
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

    return {
      found,
      lines,
      notices: await loadNoticeFeed(tx, { organizationId: actor.organizationId, actor }),
      readAt: await noticesReadAt(tx, {
        organizationId: actor.organizationId,
        userId: actor.userId,
      }),
    };
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
      /*
       * Who is coming, then which card they landed on.
       *
       * The request carries a name of its own when the client booked under one
       * the card does not have — a number the studio first met as one person is
       * used by another, which on a shared phone is the ordinary case rather
       * than the strange one. The list used to show the card alone, so a
       * request from Ольга arrived as Люда and the master had no way to tell.
       */
      client_name: row.booking.clientNameSnapshot ?? row.clientName,
      client_card_name: row.booking.clientNameSnapshot ? row.clientName : null,
      service_name: serviceLine ? resolveLocalizedText(serviceLine.nameSnapshot, locale, locale) : null,
      local_date: formatLocalDate({ year: parts.year, month: parts.month, day: parts.day }),
      local_time: formatLocalTime(parts.minutes),
    };
  });

  /*
   * The second half of the bell: what has already happened.
   *
   * Grouped by appointment, because a visit moved twice and then called off is
   * one story and one hole in the day. The hour a notice is about is not always
   * the hour the booking now says — a client who moved to another master left
   * this one an empty slot at the old time — so the line names both, and the
   * link goes to the day the reader can do something on.
   */
  const feed = groupNotices(rows.notices, rows.readAt).map((group) => {
    const at = toZonedParts(group.row.startsAt, group.row.timezone);
    const previous = group.previousStartsAt
      ? toZonedParts(new Date(group.previousStartsAt), group.row.timezone)
      : null;
    const day = (parts: ReturnType<typeof toZonedParts>) =>
      formatLocalDate({ year: parts.year, month: parts.month, day: parts.day });

    return {
      booking_id: group.bookingId,
      kind: group.kind,
      earlier: group.earlier,
      unread: group.unread,
      happened_at: group.at.toISOString(),
      client_name: group.row.clientName,
      specialist_id: group.row.specialistId,
      specialist_name: group.row.specialistName,
      local_date: day(at),
      local_time: formatLocalTime(at.minutes),
      previous_local_date: previous ? day(previous) : null,
      previous_local_time: previous ? formatLocalTime(previous.minutes) : null,
      /*
       * Where the link goes. Every other notice is about the appointment as it
       * stands, so the day it is on is the day to open; a released master's
       * appointment belongs to somebody else now, and what is theirs is the
       * hour it used to occupy.
       */
      link_date: group.kind === "client_released" && previous ? day(previous) : day(at),
    };
  });

  return apiSuccess({ pending: items, feed, unread: feed.filter((row) => row.unread).length }, id);
}
