import { and, eq, gt, isNull } from "drizzle-orm";

import {
  bookingAccessTokens,
  bookingLines,
  bookings,
  locations,
  organizations,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { parseBookingToken } from "@/domain/booking-token";
import { isPublicBookingEnabled } from "@/env";
import { resolveLocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";

export async function loadPublicBookingAccess(rawToken: string, now = new Date()) {
  // The rollback of section 7 turns off the public surface with one flag, and a
  // manage link is part of that surface: leaving it live would keep clients
  // cancelling through a booking system the studio has switched off.
  if (!isPublicBookingEnabled()) return null;

  const parsed = parseBookingToken(rawToken, "manage");
  if (!parsed) return null;

  return withTenant(parsed.organizationId, async (tx) => {
    const [access] = await tx
      .select({ id: bookingAccessTokens.id, bookingId: bookingAccessTokens.bookingId })
      .from(bookingAccessTokens)
      .where(
        and(
          eq(bookingAccessTokens.organizationId, parsed.organizationId),
          eq(bookingAccessTokens.tokenHash, parsed.tokenHash),
          eq(bookingAccessTokens.purpose, "manage"),
          gt(bookingAccessTokens.expiresAt, now),
          isNull(bookingAccessTokens.revokedAt),
        ),
      )
      .limit(1);
    if (!access) return null;

    const [row] = await tx
      .select({
        booking: bookings,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        bookingAccess: organizations.bookingAccess,
        locale: organizations.locale,
        currency: organizations.currency,
        organizationDeletedAt: organizations.deletedAt,
        locationName: locations.name,
        locationAddress: locations.address,
        timezone: locations.timezone,
        specialistName: specialists.name,
      })
      .from(bookings)
      .innerJoin(organizations, eq(organizations.id, bookings.organizationId))
      .innerJoin(locations, eq(locations.id, bookings.locationId))
      .innerJoin(specialists, eq(specialists.id, bookings.specialistId))
      .where(eq(bookings.id, access.bookingId))
      .limit(1);
    // Rolled back to the calendar, or off entirely: the client's link goes dark
    // with the page it came from, rather than staying a way into a booking
    // system the studio has stopped running.
    if (!row || row.organizationDeletedAt || !row.organizationSlug) return null;
    if (row.bookingAccess !== "public") return null;

    const lines = await tx
      .select()
      .from(bookingLines)
      .where(eq(bookingLines.bookingId, row.booking.id));
    const locale = row.locale as AppLocale;

    return {
      organizationId: parsed.organizationId,
      accessTokenId: access.id,
      booking: row.booking,
      lines,
      dto: {
        organization_name: row.organizationName,
        organization_slug: row.organizationSlug,
        locale,
        currency: row.currency,
        location: {
          id: row.booking.locationId,
          name: row.locationName,
          address: row.locationAddress,
          timezone: row.timezone,
        },
        specialist: { id: row.booking.specialistId, name: row.specialistName },
        starts_at: row.booking.startsAt.toISOString(),
        ends_at: row.booking.endsAt.toISOString(),
        status: row.booking.status,
        version: row.booking.version,
        /*
         * Why the appointment is in the state it is in, for a page that has to
         * say more than the state's name.
         *
         * "Отменена" answers nothing a client wants to know: whether they did
         * it, whether the studio did, or whether a request they sent simply ran
         * out of time. All three are the same status and need different words —
         * and only the last two need a way back to the booking page.
         *
         * Safe to publish. `cancelled_by` is an enum and `cancellation_reason`
         * is a code from a closed list, kept that way by section 7.9 precisely
         * so that no free text — a phone number, a diagnosis — is ever written
         * where it might be read back out.
         */
        cancelled_by: row.booking.cancelledBy,
        cancellation_reason: row.booking.cancellationReason,
        /*
         * When an unanswered request stops holding the slot. Null unless the
         * studio confirms by hand, which is the only case with a deadline —
         * and the only case where a client is left waiting without being told
         * how long for.
         */
        confirmation_due_at: row.booking.confirmationDueAt?.toISOString() ?? null,
        price_minor: lines.reduce((total, line) => total + line.priceMinor, 0),
        service_id: lines.find((line) => line.kind === "service")?.serviceId ?? null,
        add_on_ids: lines.flatMap((line) => (line.addOnId ? [line.addOnId] : [])),
        lines: lines.map((line) => ({
          kind: line.kind,
          name: resolveLocalizedText(line.nameSnapshot, locale, locale) ?? "—",
          price_minor: line.priceMinor,
          duration_minutes: line.durationMinutes,
        })),
      },
    };
  });
}

export type PublicBookingAccess = NonNullable<Awaited<ReturnType<typeof loadPublicBookingAccess>>>;

/**
 * Has anything changed — and nothing else.
 *
 * The manage page checks this on a timer while a request waits to be answered,
 * so that a client watching the screen learns the studio confirmed even when
 * the email is still in a queue, or in a spam folder, or was never possible
 * because they have no address. It is the one place the product tells somebody
 * something without sending them a message.
 *
 * A separate query rather than `loadPublicBookingAccess` with the answer thrown
 * away: that one reads the lines, the location, the specialist and the studio,
 * and localizes every service name, to build a page that is already on screen.
 * Called every thirty seconds it would be the most expensive read the public
 * surface makes, for two columns.
 *
 * The organization is still joined. The public surface is switched off per
 * tenant, and a page that kept polling after the rollback would be the one part
 * of it still running — see the flag check in `loadPublicBookingAccess`.
 */
export async function loadPublicBookingStatus(rawToken: string, now = new Date()) {
  if (!isPublicBookingEnabled()) return null;

  const parsed = parseBookingToken(rawToken, "manage");
  if (!parsed) return null;

  return withTenant(parsed.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        status: bookings.status,
        version: bookings.version,
        bookingAccess: organizations.bookingAccess,
        organizationDeletedAt: organizations.deletedAt,
      })
      .from(bookingAccessTokens)
      .innerJoin(bookings, eq(bookings.id, bookingAccessTokens.bookingId))
      .innerJoin(organizations, eq(organizations.id, bookings.organizationId))
      .where(
        and(
          eq(bookingAccessTokens.organizationId, parsed.organizationId),
          eq(bookingAccessTokens.tokenHash, parsed.tokenHash),
          eq(bookingAccessTokens.purpose, "manage"),
          gt(bookingAccessTokens.expiresAt, now),
          isNull(bookingAccessTokens.revokedAt),
        ),
      )
      .limit(1);

    if (!row || row.organizationDeletedAt || row.bookingAccess !== "public") return null;

    return { status: row.status, version: row.version };
  });
}
