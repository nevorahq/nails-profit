import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { bookingSettings, locations, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { checkSlug, slugCandidatesFor } from "@/domain/slug";
import { isSupportedTimezone } from "@/domain/timezone";
import { recordAuditEvent } from "@/lib/audit";
import { bookingModuleRefusal } from "@/lib/booking-http";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Locations, roadmap section 7.4.
 *
 * A location carries its own IANA timezone rather than inheriting the
 * organization's for good: a studio with two addresses can straddle a border,
 * and every schedule rule underneath is written in the local time of one
 * address. The organization's zone is only the default a new location starts
 * from.
 *
 * Creating one also creates its booking configuration, in the same transaction.
 * A location without settings would be a location the availability engine can
 * neither publish nor refuse to publish — and defaults that exist are easier to
 * reason about than nulls that mean "ask somewhere else".
 */
const createLocationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /**
   * Optional, and absent from every screen: derived from `name` when not sent.
   *
   * It is the address's key inside the studio and appears in no public URL —
   * the booking page lives at the organization's slug — yet the «Добавить
   * адрес» form used to ask for it under «Адрес в ссылке» with a promise that it
   * «входит в ссылку и потом не меняется». Neither half was true. A caller that
   * does send one is still held to `checkSlug` and to uniqueness.
   */
  slug: z.string().trim().toLowerCase().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  timezone: z.string().trim().max(64).optional(),
  sort_order: z.int().min(0).max(1_000).optional(),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  // Everyone who may read a booking may see where the work happens: a master
  // cannot be told "your Tuesday is at the other address" by a screen that
  // hides the address.
  if (!can(caller.membership.role, "bookings", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read locations", id);
  }

  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx
      .select({
        id: locations.id,
        slug: locations.slug,
        name: locations.name,
        address: locations.address,
        timezone: locations.timezone,
        status: locations.status,
        sort_order: locations.sortOrder,
        version: locations.version,
        public_status: bookingSettings.publicStatus,
        slot_step_minutes: bookingSettings.slotStepMinutes,
        min_lead_minutes: bookingSettings.minLeadMinutes,
        max_advance_days: bookingSettings.maxAdvanceDays,
        buffer_before_minutes: bookingSettings.bufferBeforeMinutes,
        buffer_after_minutes: bookingSettings.bufferAfterMinutes,
        confirmation_mode: bookingSettings.confirmationMode,
        confirmation_ttl_minutes: bookingSettings.confirmationTtlMinutes,
      })
      .from(locations)
      .leftJoin(bookingSettings, eq(bookingSettings.locationId, locations.id))
      .orderBy(asc(locations.sortOrder), asc(locations.createdAt)),
  );

  return apiSuccess(rows, id);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  // An address, its timezone and whether it is published are organization
  // settings in everything but name, and section 6.1 gives those to the Owner.
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage locations", id);
  }
  const disabled = await bookingModuleRefusal(actor.organizationId, id, "write");
  if (disabled) return disabled;

  const body = await request.json().catch(() => null);
  const parsed = createLocationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const chosenSlug = parsed.data.slug;
  const slugProblem = chosenSlug === undefined ? null : checkSlug(chosenSlug);
  if (slugProblem) {
    return apiError(422, "INVALID_SLUG", "The slug cannot be used", id, {
      fieldErrors: [{ field: "slug", code: slugProblem, message: "The slug cannot be used" }],
    });
  }

  const timezone = parsed.data.timezone;
  if (timezone !== undefined && !isSupportedTimezone(timezone)) {
    // Refused rather than defaulted: a schedule written against a zone the
    // runtime does not know would silently be interpreted as UTC, and every
    // slot in the day would be offered at the wrong hour.
    return apiError(422, "UNKNOWN_TIMEZONE", "The timezone is not a known IANA name", id, {
      fieldErrors: [{ field: "timezone", code: "unknown", message: "Unknown IANA timezone" }],
    });
  }

  const createLocation = () =>
    withTenant(actor.organizationId, async (tx) => {
      const [organization] = await tx
        .select({ timezone: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, actor.organizationId))
        .limit(1);

      // The first candidate this studio's other addresses have not taken: a
      // second «Central» becomes `central-2` rather than a refusal over a field
      // nobody was shown.
      let slug = chosenSlug;
      if (slug === undefined) {
        const candidates = slugCandidatesFor(parsed.data.name);
        const taken = new Set(
          (
            await tx
              .select({ slug: locations.slug })
              .from(locations)
              .where(inArray(locations.slug, candidates))
          ).map((row) => row.slug),
        );
        slug =
          candidates.find((candidate) => !taken.has(candidate)) ??
          `${candidates[0].slice(0, 31)}-${crypto.randomUUID().slice(0, 8)}`;
      }

      const [location] = await tx
        .insert(locations)
        .values({
          organizationId: actor.organizationId,
          slug,
          name: parsed.data.name,
          address: parsed.data.address ?? null,
          timezone: timezone ?? organization.timezone,
          sortOrder: parsed.data.sort_order ?? 0,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();

      await tx.insert(bookingSettings).values({
        organizationId: actor.organizationId,
        locationId: location.id,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "location.created",
        entityType: "location",
        entityId: location.id,
        after: { slug: location.slug, timezone: location.timezone },
        requestId: id,
      });

      return location;
    });

  try {
    // A derived slug can lose a race to a second address created with the same
    // name in the same instant; asking again picks the next candidate. A slug
    // the caller chose is theirs to change, so that one is refused at once.
    let created: Awaited<ReturnType<typeof createLocation>>;
    for (let attempt = 0; ; attempt++) {
      try {
        created = await createLocation();
        break;
      } catch (error) {
        const derived = chosenSlug === undefined;
        if (derived && attempt < 2 && isUniqueViolation(error, "location_org_slug_idx")) continue;
        throw error;
      }
    }

    return apiSuccess(
      {
        id: created.id,
        slug: created.slug,
        name: created.name,
        address: created.address,
        timezone: created.timezone,
        status: created.status,
      },
      id,
      201,
    );
  } catch (error) {
    if (isUniqueViolation(error, "location_org_slug_idx")) {
      return apiError(409, "SLUG_TAKEN", "This slug is already used by another location", id);
    }
    throw error;
  }
}
