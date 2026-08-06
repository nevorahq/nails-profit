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
