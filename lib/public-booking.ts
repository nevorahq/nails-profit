import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { Currency } from "@/domain/money";
import { db } from "@/db";
import {
  addOns,
  bookingSettings,
  locations,
  organizations,
  serviceAddOns,
  services,
  specialistAvatars,
  specialistLocations,
  specialistServices,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { withTenant } from "@/db/tenant";
import { getPublicNotificationChannel, isPlanLimitsEnforced, isPublicBookingEnabled } from "@/env";
import { resolveLocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";
import { workingSpecialistIds } from "@/lib/plan";

export type PublicOrganization = Readonly<{
  id: string;
  slug: string;
  name: string;
  locale: AppLocale;
  currency: Currency;
}>;

export async function findPublicOrganization(slug: string): Promise<PublicOrganization | null> {
  if (!isPublicBookingEnabled()) return null;

  const [organization] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      locale: organizations.locale,
      currency: organizations.currency,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.slug, slug),
        isNull(organizations.deletedAt),
        // Section 7.11 keeps every public route behind a per-organization flag
        // until that tenant is through the security and concurrency gates. The
        // environment flag above is the deployment-wide switch; this one is the
        // studio-by-studio rollout the pilot actually runs.
        eq(organizations.bookingAccess, "public"),
      ),
    )
    .limit(1);

  return organization?.slug
    ? { ...organization, slug: organization.slug, locale: organization.locale as AppLocale }
    : null;
}

export type PublicLocation = Readonly<{
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  confirmation_mode: "instant" | "manual";
  /** The form has to know whether a code step stands between hold and booking. */
  verification_mode: "off" | "code";
}>;

export async function loadPublicProfile(slug: string) {
  const organization = await findPublicOrganization(slug);
  if (!organization) return null;

  const published = await withTenant(organization.id, (tx) =>
    tx
      .select({
        id: locations.id,
        name: locations.name,
        address: locations.address,
        timezone: locations.timezone,
        confirmation_mode: bookingSettings.confirmationMode,
        verification_mode: bookingSettings.verificationMode,
      })
      .from(locations)
      .innerJoin(bookingSettings, eq(bookingSettings.locationId, locations.id))
      .where(
        and(
          eq(locations.status, "active"),
          eq(bookingSettings.publicStatus, "published"),
        ),
      )
      .orderBy(asc(locations.sortOrder), asc(locations.id)),
  );

  if (published.length === 0) return null;
  return {
    organization,
    dto: {
      slug: organization.slug,
      name: organization.name,
      locale: organization.locale,
      currency: organization.currency,
      notification_channel: getPublicNotificationChannel(),
      locations: published satisfies PublicLocation[],
    },
  };
}

export type PublicSpecialist = Readonly<{
  id: string;
  name: string;
  sortOrder: number;
  /** What they charge for the service asked about, when it is not its list price. */
  ownPriceMinor: number | null;
  /** And how long they take for it, when that is not the service's own length. */
  ownDurationMinutes: number | null;
}>;

/** Specialists assigned to both the location and the requested service. */
export async function publicSpecialistsFor(
  tx: TenantTransaction,
  locationId: string,
  serviceId: string,
): Promise<PublicSpecialist[]> {
  let people = await tx
    .select({ id: specialists.id, name: specialists.name, sortOrder: specialists.sortOrder })
    .from(specialists)
    .innerJoin(specialistLocations, eq(specialistLocations.specialistId, specialists.id))
    .where(
      and(
        eq(specialistLocations.locationId, locationId),
        isNull(specialists.archivedAt),
      ),
    )
    .orderBy(asc(specialists.sortOrder), asc(specialists.id));

  /*
   * A studio on a one-person tier with more people on file than that takes
   * appointments for its first one only — see `workingSpecialistIds`. The
   * rest stay out of the catalogue rather than being offered and refused.
   */
  if (isPlanLimitsEnforced()) {
    const [place] = await tx
      .select({ organizationId: locations.organizationId })
      .from(locations)
      .where(eq(locations.id, locationId))
      .limit(1);
    const working = place ? await workingSpecialistIds(tx, place.organizationId) : null;
    if (working) people = people.filter((person) => working.has(person.id));
  }

  if (people.length === 0) return [];

  const assignments = await tx
    .select({
      specialistId: specialistServices.specialistId,
      serviceId: specialistServices.serviceId,
      priceMinor: specialistServices.priceOverrideMinor,
      durationMinutes: specialistServices.durationOverrideMinutes,
    })
    .from(specialistServices)
    .where(inArray(specialistServices.specialistId, people.map((person) => person.id)));

  return people
    .filter((person) => {
      const own = assignments.filter((assignment) => assignment.specialistId === person.id);
      // Empty means the solo-friendly “all active services” convention used by
      // the internal booking endpoint as well.
      return own.length === 0 || own.some((assignment) => assignment.serviceId === serviceId);
    })
    .map((person) => {
      const own = assignments.find(
        (assignment) => assignment.specialistId === person.id && assignment.serviceId === serviceId,
      );
      return { ...person, ownPriceMinor: own?.priceMinor ?? null, ownDurationMinutes: own?.durationMinutes ?? null };
    });
}

export async function loadPublicCatalog(slug: string, locationId: string) {
  const profile = await loadPublicProfile(slug);
  if (!profile || !profile.dto.locations.some((location) => location.id === locationId)) return null;

  return withTenant(profile.organization.id, async (tx) => {
    const catalogue = await tx
      .select({
        id: services.id,
        name: services.name,
        priceMinor: services.priceMinor,
        durationMinutes: services.durationMinutes,
      })
      .from(services)
      .where(
        and(
          isNull(services.archivedAt),
          // Public quotes cannot contain an invented price or duration.
          // Drizzle's nullable fields are narrowed below after this SQL check.
          eq(services.currency, profile.organization.currency),
        ),
      )
      .orderBy(asc(services.createdAt), asc(services.id));

    const bookable = catalogue.filter(
      (service): service is typeof service & { priceMinor: number; durationMinutes: number } =>
        service.priceMinor !== null && service.durationMinutes !== null,
    );
    const links =
      bookable.length === 0
        ? []
        : await tx
            .select({ serviceId: serviceAddOns.serviceId, addOnId: serviceAddOns.addOnId })
            .from(serviceAddOns)
            .where(inArray(serviceAddOns.serviceId, bookable.map((service) => service.id)));
    const extras =
      links.length === 0
        ? []
        : await tx
            .select({
              id: addOns.id,
              name: addOns.name,
              priceDeltaMinor: addOns.priceDeltaMinor,
              durationDeltaMinutes: addOns.durationDeltaMinutes,
            })
            .from(addOns)
            .where(
              and(
                inArray(addOns.id, links.map((link) => link.addOnId)),
                isNull(addOns.archivedAt),
              ),
            );

    const serviceDtos = [];
    for (const service of bookable) {
      const people = await publicSpecialistsFor(tx, locationId, service.id);
      if (people.length === 0) continue;
      serviceDtos.push({
        id: service.id,
        name:
          resolveLocalizedText(service.name, profile.organization.locale, profile.organization.locale) ??
          "—",
        price_minor: service.priceMinor,
        duration_minutes: service.durationMinutes,
        add_ons: links
          .filter((link) => link.serviceId === service.id)
          .map((link) => extras.find((extra) => extra.id === link.addOnId))
          .filter((extra): extra is NonNullable<typeof extra> => Boolean(extra))
          .map((extra) => ({
            id: extra.id,
            name:
              resolveLocalizedText(extra.name, profile.organization.locale, profile.organization.locale) ??
              "—",
            price_delta_minor: extra.priceDeltaMinor,
            duration_delta_minutes: extra.durationDeltaMinutes,
          })),
        // What each master charges, and how long they take: their own, or the list's.
        specialists: people.map(({ id, name, ownPriceMinor, ownDurationMinutes }) => ({
          id,
          name,
          price_minor: ownPriceMinor ?? service.priceMinor,
          duration_minutes: ownDurationMinutes ?? service.durationMinutes,
        })),
      });
    }

    // One read for every face on the page, not one per service: a master who
    // does six services is still one picture.
    const faceIds = [...new Set(serviceDtos.flatMap((service) => service.specialists.map((person) => person.id)))];
    const faces =
      faceIds.length === 0
        ? []
        : await tx
            .select({ specialistId: specialistAvatars.specialistId, version: specialistAvatars.version })
            .from(specialistAvatars)
            .where(inArray(specialistAvatars.specialistId, faceIds));
    const photoVersion = new Map(faces.map((face) => [face.specialistId, face.version]));

    return {
      organization: profile.organization,
      location: profile.dto.locations.find((location) => location.id === locationId)!,
      dto: {
        services: serviceDtos.map((service) => ({
          ...service,
          specialists: service.specialists.map((person) => ({
            ...person,
            photo_version: photoVersion.get(person.id) ?? null,
          })),
        })),
      },
    };
  });
}

/**
 * Whose face a public page may show: a master who can be booked on a published
 * address of a studio that takes public bookings, and nobody else.
 *
 * The staff endpoint is behind a session; this one is not, so the question of
 * which photos it hands out is answered here rather than left to a guessed id.
 * A card that is archived, or that sits on no published address, is not on the
 * page, and neither is its picture.
 */
export async function loadPublicAvatar(slug: string, specialistId: string, options: { bytes: boolean }) {
  const organization = await findPublicOrganization(slug);
  if (!organization) return null;

  return withTenant(organization.id, async (tx) => {
    const [meta] = await tx
      .select({
        mimeType: specialistAvatars.mimeType,
        version: specialistAvatars.version,
        updatedAt: specialistAvatars.updatedAt,
      })
      .from(specialistAvatars)
      .innerJoin(specialists, eq(specialists.id, specialistAvatars.specialistId))
      .innerJoin(specialistLocations, eq(specialistLocations.specialistId, specialists.id))
      .innerJoin(bookingSettings, eq(bookingSettings.locationId, specialistLocations.locationId))
      .where(
        and(
          eq(specialistAvatars.specialistId, specialistId),
          isNull(specialists.archivedAt),
          eq(bookingSettings.publicStatus, "published"),
        ),
      )
      .limit(1);
    if (!meta) return null;
    if (!options.bytes) return { ...meta, bytes: null };

    const [row] = await tx
      .select({ bytes: specialistAvatars.bytes })
      .from(specialistAvatars)
      .where(eq(specialistAvatars.specialistId, specialistId))
      .limit(1);
    return row ? { ...meta, bytes: row.bytes } : null;
  });
}
