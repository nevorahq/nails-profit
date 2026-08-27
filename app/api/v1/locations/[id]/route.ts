import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  availabilityExceptions,
  bookingHolds,
  bookingSettings,
  bookings,
  locations,
  scheduleRules,
  specialistLocations,
  workplaces,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { checkSlug } from "@/domain/slug";
import { isSupportedTimezone } from "@/domain/timezone";
import { recordAuditEvent } from "@/lib/audit";
import { bookingModuleRefusal } from "@/lib/booking-http";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Editing a location.
 *
 * Archiving is a status change rather than a delete: schedule rules, bookings
 * and finished visits all reference the address, and section 15.3's rule about
 * keeping required records applies to where the money was earned as much as to
 * the amount.
 *
 * The timezone is editable but audited with both sides. Changing it moves every
 * future slot the location offers by the difference in offsets, which is a
 * decision someone should be able to trace afterwards.
 */
const patchLocationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  slug: z.string().trim().toLowerCase().max(40).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  timezone: z.string().trim().max(64).optional(),
  status: z.enum(["active", "archived"]).optional(),
  sort_order: z.int().min(0).max(1_000).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage locations", requestIdentifier);
  }
  const disabled = await bookingModuleRefusal(actor.organizationId, requestIdentifier, "write");
  if (disabled) return disabled;

  const body = await request.json().catch(() => null);
  const parsed = patchLocationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  if (parsed.data.slug !== undefined) {
    const problem = checkSlug(parsed.data.slug);
    if (problem) {
      return apiError(422, "INVALID_SLUG", "The slug cannot be used", requestIdentifier, {
        fieldErrors: [{ field: "slug", code: problem, message: "The slug cannot be used" }],
      });
    }
  }

  if (parsed.data.timezone !== undefined && !isSupportedTimezone(parsed.data.timezone)) {
    return apiError(422, "UNKNOWN_TIMEZONE", "The timezone is not a known IANA name", requestIdentifier, {
      fieldErrors: [{ field: "timezone", code: "unknown", message: "Unknown IANA timezone" }],
    });
  }

  const { id } = await context.params;

  try {
    const updated = await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx.select().from(locations).where(eq(locations.id, id)).limit(1);
      if (!existing) return null;

      const [location] = await tx
        .update(locations)
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
          ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
          ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
          ...(parsed.data.sort_order !== undefined ? { sortOrder: parsed.data.sort_order } : {}),
          updatedBy: actor.userId,
          updatedAt: new Date(),
          version: sql`${locations.version} + 1`,
        })
        .where(eq(locations.id, id))
        .returning();

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "location.updated",
        entityType: "location",
        entityId: location.id,
        before: { slug: existing.slug, timezone: existing.timezone, status: existing.status },
        after: { slug: location.slug, timezone: location.timezone, status: location.status },
        requestId: requestIdentifier,
      });

      return location;
    });

    if (!updated) {
      return apiError(404, "LOCATION_NOT_FOUND", "No location with this ID", requestIdentifier);
    }

    return apiSuccess(
      {
        id: updated.id,
        slug: updated.slug,
        name: updated.name,
        address: updated.address,
        timezone: updated.timezone,
        status: updated.status,
        sort_order: updated.sortOrder,
        version: updated.version,
      },
      requestIdentifier,
    );
  } catch (error) {
    if (isUniqueViolation(error, "location_org_slug_idx")) {
      return apiError(409, "SLUG_TAKEN", "This slug is already used by another location", requestIdentifier);
    }
    throw error;
  }
}

/**
 * Removing an address that was never used.
 *
 * The rule this file states at the top still holds: an address a client was
 * booked at is a record of where money was earned, and it is archived rather
 * than deleted. What that rule never covered is the address typed with a
 * misspelling and abandoned five seconds later — it is a record of nothing, and
 * leaving it on the screen forever as «в архиве» is the product being pedantic
 * rather than careful.
 *
 * So: a booking is what makes an address history. One row in `booking` and this
 * refuses and says to archive instead. With none, the address goes, and its own
 * configuration goes with it — settings, seats, assignments, the rota, day
 * exceptions and any hold still standing. Those describe *this* address and
 * mean nothing without it; every one of them is `ON DELETE restrict`, which is
 * the database making sure the decision is taken here rather than by a cascade
 * nobody reviewed.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage locations", requestIdentifier);
  }
  const disabled = await bookingModuleRefusal(actor.organizationId, requestIdentifier, "write");
  if (disabled) return disabled;

  const { id } = await context.params;

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx.select().from(locations).where(eq(locations.id, id)).limit(1);
    if (!existing) return null;

    const [{ value: bookingCount }] = await tx
      .select({ value: count() })
      .from(bookings)
      .where(eq(bookings.locationId, id));
    if (bookingCount > 0) return { blocked: bookingCount } as const;

    /*
     * A published address is one clients are being sent to right now, and this
     * is the only irreversible control on that screen. Taking the page down is
     * a separate decision from discarding the address, so it is made
     * separately: unpublish, then delete. One click of "снять с публикации"
     * stands between the two, and it is the click that makes the second one
     * survivable — the studio sees the page go before the rota, the
     * assignments and the settings go with it.
     */
    const [settings] = await tx
      .select({ publicStatus: bookingSettings.publicStatus })
      .from(bookingSettings)
      .where(eq(bookingSettings.locationId, id))
      .limit(1);
    if (settings?.publicStatus === "published") return { published: true } as const;

    // Order matters: holds and exceptions point at the rota's address, and every
    // reference is `restrict`, so the leaves go before the address itself.
    await tx.delete(bookingHolds).where(eq(bookingHolds.locationId, id));
    await tx.delete(availabilityExceptions).where(eq(availabilityExceptions.locationId, id));
    await tx.delete(scheduleRules).where(eq(scheduleRules.locationId, id));
    await tx.delete(specialistLocations).where(eq(specialistLocations.locationId, id));
    await tx.delete(workplaces).where(eq(workplaces.locationId, id));
    await tx.delete(bookingSettings).where(eq(bookingSettings.locationId, id));
    await tx.delete(locations).where(eq(locations.id, id));

    /*
     * The whole row, not just its id. The audit event is the only place this
     * address will exist afterwards, so a later question about what was removed
     * has to be answerable from the event alone.
     */
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "location.deleted",
      entityType: "location",
      entityId: existing.id,
      before: {
        slug: existing.slug,
        name: existing.name,
        address: existing.address,
        timezone: existing.timezone,
        status: existing.status,
      },
      after: null,
      requestId: requestIdentifier,
    });

    return { deleted: existing.id } as const;
  });

  if (!outcome) {
    return apiError(404, "LOCATION_NOT_FOUND", "No location with this ID", requestIdentifier);
  }
  if ("published" in outcome) {
    return apiError(
      409,
      "LOCATION_PUBLISHED",
      "The address is published and has to be taken off the public page first",
      requestIdentifier,
    );
  }
  if ("blocked" in outcome) {
    return apiError(
      409,
      "LOCATION_HAS_BOOKINGS",
      "The address has bookings and can only be archived",
      requestIdentifier,
      { details: { booking_count: outcome.blocked } },
    );
  }

  return apiSuccess({ id: outcome.deleted }, requestIdentifier);
}
