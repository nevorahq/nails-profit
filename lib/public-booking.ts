import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/db";
import {
  addOns,
  bookingSettings,
  locations,
  organizations,
  serviceAddOns,
  services,
  specialistLocations,
  specialistServices,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { withTenant } from "@/db/tenant";
import { isPublicBookingEnabled } from "@/env";
import { resolveLocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";

export type PublicOrganization = Readonly<{
  id: string;
  slug: string;
  name: string;
  locale: AppLocale;
  currency: "MDL" | "EUR";
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
    .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
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
      locations: published satisfies PublicLocation[],
    },
  };
}

export type PublicSpecialist = Readonly<{
  id: string;
  name: string;
  sortOrder: number;
}>;

/** Specialists assigned to both the location and the requested service. */
export async function publicSpecialistsFor(
  tx: TenantTransaction,
  locationId: string,
  serviceId: string,
): Promise<PublicSpecialist[]> {
  const people = await tx
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

  if (people.length === 0) return [];

  const assignments = await tx
    .select({
      specialistId: specialistServices.specialistId,
      serviceId: specialistServices.serviceId,
    })
    .from(specialistServices)
    .where(inArray(specialistServices.specialistId, people.map((person) => person.id)));

  return people.filter((person) => {
    const own = assignments.filter((assignment) => assignment.specialistId === person.id);
    // Empty means the solo-friendly “all active services” convention used by
    // the internal booking endpoint as well.
    return own.length === 0 || own.some((assignment) => assignment.serviceId === serviceId);
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
        specialists: people.map(({ id, name }) => ({ id, name })),
      });
    }

    return {
      organization: profile.organization,
      location: profile.dto.locations.find((location) => location.id === locationId)!,
      dto: { services: serviceDtos },
    };
  });
}
