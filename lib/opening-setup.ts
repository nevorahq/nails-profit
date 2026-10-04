import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  bookingSettings,
  locations,
  organizations,
  scheduleRules,
  services,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import type { MemberRole } from "@/domain/rbac";
import { catalogueEntry, serviceCatalogue } from "@/domain/service-catalogue";
import { DEFAULT_WORKWEEK } from "@/domain/workspace-defaults";
import { resolveLocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";
import { recordAuditEvent } from "@/lib/audit";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";
import { replaceWeeklySchedule } from "@/lib/schedule-rules";

/**
 * The opening screen: the prices and the week a studio starts taking clients on.
 *
 * Registration still fills both in — a manicure at 200, Monday to Friday 08–16
 * — because an empty catalogue answers no question the first screen asks. What
 * changed is that those are a draft now: nothing is published until the owner
 * has looked at them here, and the one button that publishes saves them first,
 * in the same transaction, so a page can never open on prices the save did not
 * reach.
 */

export type OpeningSetupView = Readonly<{
  confirmed: boolean;
  wantsOnlineBooking: boolean;
  bookingPublished: boolean;
  /** The services the studio already sells, ticked and editable. */
  services: readonly { id: string; name: string; priceMinor: number | null; durationMinutes: number | null }[];
  /** Catalogue kinds not yet among them, offered unticked. */
  catalogue: readonly { key: string; name: string; durationMinutes: number }[];
  /**
   * The week, when there is somebody here whose week it is — the owner's own
   * card. A studio whose owner does not work sets its masters' weeks in
   * «Онлайн-запись», as it always has, and gets no hours on this screen.
   */
  week: { weekdays: number[]; startMinute: number; endMinute: number } | null;
}>;

/** The address the screen speaks for: the studio's first, which is the one registration made. */
async function firstLocation(tx: TenantTransaction) {
  const [location] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.status, "active"))
    .orderBy(asc(locations.createdAt), asc(locations.id))
    .limit(1);
  return location ?? null;
}

async function ownerCard(tx: TenantTransaction, userId: string) {
  const [card] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(and(eq(specialists.userId, userId), isNull(specialists.archivedAt)))
    .limit(1);
  return card ?? null;
}

export async function loadOpeningSetup(
  tx: TenantTransaction,
  input: Readonly<{ organizationId: string; userId: string; locale: AppLocale }>,
): Promise<OpeningSetupView> {
  const [organization] = await tx
    .select({
      setupConfirmedAt: organizations.setupConfirmedAt,
      wantsOnlineBooking: organizations.wantsOnlineBooking,
      bookingAccess: organizations.bookingAccess,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId));

  const active = await tx
    .select({
      id: services.id,
      name: services.name,
      priceMinor: services.priceMinor,
      durationMinutes: services.durationMinutes,
    })
    .from(services)
    .where(isNull(services.archivedAt))
    .orderBy(asc(services.createdAt), asc(services.id));

  const named = active.map((service) => ({
    id: service.id,
    name: resolveLocalizedText(service.name, input.locale, input.locale) ?? "",
    priceMinor: service.priceMinor,
    durationMinutes: service.durationMinutes,
  }));
  // A kind already sold is not offered twice. Matched on the name in any of
  // the three languages, because that is what registration wrote it with.
  const sold = new Set(
    active.flatMap((service) => Object.values(service.name ?? {}).map((name) => String(name).trim().toLowerCase())),
  );
  const catalogue = serviceCatalogue
    .filter((entry) => !Object.values(entry.name).some((name) => sold.has(String(name).trim().toLowerCase())))
    .map((entry) => ({
      key: entry.key,
      name: resolveLocalizedText(entry.name, input.locale, input.locale) ?? entry.name.ru,
      durationMinutes: entry.durationMinutes,
    }));

  const location = await firstLocation(tx);
  const card = await ownerCard(tx, input.userId);

  let week: OpeningSetupView["week"] = null;
  if (card && location) {
    const today = new Date().toISOString().slice(0, 10);
    const rules = await tx
      .select({
        weekday: scheduleRules.weekday,
        startMinute: scheduleRules.startMinute,
        endMinute: scheduleRules.endMinute,
      })
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.specialistId, card.id),
          eq(scheduleRules.locationId, location.id),
          lte(scheduleRules.effectiveFrom, today),
          or(isNull(scheduleRules.effectiveTo), gt(scheduleRules.effectiveTo, today)),
        ),
      );
    // One span a day is what this screen can say. A week with a lunch break
    // reads as its outer hours here and keeps its detail in «Онлайн-запись»
    // until somebody saves this screen over it.
    week =
      rules.length === 0
        ? {
            weekdays: [...DEFAULT_WORKWEEK.weekdays],
            startMinute: DEFAULT_WORKWEEK.startMinute,
            endMinute: DEFAULT_WORKWEEK.endMinute,
          }
        : {
            weekdays: [...new Set(rules.map((rule) => rule.weekday))].sort((a, b) => a - b),
            startMinute: Math.min(...rules.map((rule) => rule.startMinute)),
            endMinute: Math.max(...rules.map((rule) => rule.endMinute)),
          };
  }

  const [published] = location
    ? await tx
        .select({ id: bookingSettings.id })
        .from(bookingSettings)
        .where(and(eq(bookingSettings.locationId, location.id), eq(bookingSettings.publicStatus, "published")))
        .limit(1)
    : [];

  return {
    confirmed: organization?.setupConfirmedAt != null,
    wantsOnlineBooking: organization?.wantsOnlineBooking ?? false,
    bookingPublished: published !== undefined && organization?.bookingAccess === "public",
    services: named,
    catalogue,
    week,
  };
}

export type OpeningSetupInput = Readonly<{
  services: readonly Readonly<{
    id?: string;
    key?: string;
    priceMinor: number;
    durationMinutes: number;
  }>[];
  archiveServiceIds: readonly string[];
  week: Readonly<{ weekdays: readonly number[]; startMinute: number; endMinute: number }> | null;
  openBooking: boolean;
}>;

export type OpeningSetupFailure =
  | "SERVICE_NOT_FOUND"
  | "UNKNOWN_SERVICE_KIND"
  | "NO_OWNER_CARD"
  | "LOCATION_NOT_FOUND";

/**
 * Saves the screen: prices, the owner's week, the confirmation, and — only when
 * asked — the opening of the page, all or nothing.
 */
export async function saveOpeningSetup(
  tx: TenantTransaction,
  actor: Readonly<{ organizationId: string; userId: string; role: MemberRole }>,
  input: OpeningSetupInput,
  requestId: string,
): Promise<{ failure: OpeningSetupFailure } | { published: boolean }> {
  const [organization] = await tx
    .select({ currency: organizations.currency })
    .from(organizations)
    .where(eq(organizations.id, actor.organizationId));

  const touchedIds = [...input.services.flatMap((service) => (service.id ? [service.id] : [])), ...input.archiveServiceIds];
  if (touchedIds.length > 0) {
    const found = await tx
      .select({ id: services.id })
      .from(services)
      .where(and(inArray(services.id, touchedIds), isNull(services.archivedAt)));
    if (found.length !== new Set(touchedIds).size) return { failure: "SERVICE_NOT_FOUND" };
  }

  for (const service of input.services) {
    if (service.id) {
      await tx
        .update(services)
        .set({
          priceMinor: service.priceMinor,
          durationMinutes: service.durationMinutes,
          updatedBy: actor.userId,
          updatedAt: new Date(),
          version: sql`${services.version} + 1`,
        })
        .where(eq(services.id, service.id));
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "service.updated",
        entityType: "service",
        entityId: service.id,
        after: { price_minor: service.priceMinor, duration_minutes: service.durationMinutes },
        requestId,
      });
      continue;
    }
    const entry = service.key ? catalogueEntry(service.key) : undefined;
    if (!entry) return { failure: "UNKNOWN_SERVICE_KIND" };
    const [created] = await tx
      .insert(services)
      .values({
        organizationId: actor.organizationId,
        name: entry.name,
        priceMinor: service.priceMinor,
        durationMinutes: service.durationMinutes,
        currency: organization.currency,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: services.id });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "service.created",
      entityType: "service",
      entityId: created.id,
      after: { price_minor: service.priceMinor, duration_minutes: service.durationMinutes },
      requestId,
    });
  }

  for (const serviceId of input.archiveServiceIds) {
    await tx
      .update(services)
      .set({ archivedAt: new Date(), updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(services.id, serviceId));
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "service.archived",
      entityType: "service",
      entityId: serviceId,
      after: { archived: true },
      requestId,
    });
  }

  const location = await firstLocation(tx);
  if (input.week) {
    const card = await ownerCard(tx, actor.userId);
    if (!card) return { failure: "NO_OWNER_CARD" };
    if (!location) return { failure: "LOCATION_NOT_FOUND" };
    await replaceWeeklySchedule(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      specialistId: card.id,
      locationId: location.id,
      effectiveFrom: new Date().toISOString().slice(0, 10),
      intervals: input.week.weekdays.map((weekday) => ({
        weekday,
        startMinute: input.week!.startMinute,
        endMinute: input.week!.endMinute,
      })),
      requestId,
    });
  }

  await recordCompletedServiceCostEvents(tx, actor);

  await tx
    .update(organizations)
    .set({
      setupConfirmedAt: new Date(),
      updatedBy: actor.userId,
      updatedAt: new Date(),
      version: sql`${organizations.version} + 1`,
    })
    .where(eq(organizations.id, actor.organizationId));

  /*
   * Opening is the last thing written, after the prices it opens on. Both
   * switches together — the address and the organization — because a page
   * that one of them still holds shut is a 404 the owner was told is open.
   */
  let published = false;
  if (input.openBooking) {
    if (!location) return { failure: "LOCATION_NOT_FOUND" };
    await tx
      .update(bookingSettings)
      .set({
        publicStatus: "published",
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${bookingSettings.version} + 1`,
      })
      .where(eq(bookingSettings.locationId, location.id));
    await tx
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, actor.organizationId));
    published = true;
  }

  await recordAuditEvent(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    eventType: "organization.setup_confirmed",
    entityType: "organization",
    entityId: actor.organizationId,
    after: {
      services: input.services.length,
      archived: input.archiveServiceIds.length,
      week: input.week !== null,
      published,
    },
    requestId,
  });

  return { published };
}
