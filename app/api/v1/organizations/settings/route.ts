import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { checkSlug } from "@/domain/slug";
import { businessTypes } from "@/i18n/business-labels";
import { supportedLocales } from "@/i18n/messages";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

const settingsSchema = z
  .object({
    locale: z.enum(supportedLocales).optional(),
    currency: z.enum(["MDL", "EUR"]).optional(),
    /**
     * Studio or working alone. Wording only — it reaches no figure, recomputes
     * no history, and changes no rule about what may be recorded. See
     * `i18n/business-labels.ts`.
     */
    type: z.enum(businessTypes).optional(),
    /** What the owner keeps in the business before anything is withdrawable. */
    withdrawal_reserve_minor: z.int().min(0).optional(),
    /**
     * The sellable share of the rota, in basis points. Bounded the same way the
     * column is: zero would make every rate a division by nothing, and more
     * than the rota is a claim this figure does not make.
     */
    practical_capacity_basis_points: z.int().min(1).max(10_000).optional(),
    name: z.string().trim().min(2).max(100).optional(),
    slug: z.string().trim().toLowerCase().min(3).max(40).nullable().optional(),
    /**
     * Section 7.11's rollout switch. An owner may step it down — closing their
     * own public page or the whole module is their decision to make at any
     * hour — but stepping *up* to `public` is what the operator does after the
     * security and concurrency gates, so it is refused here.
     */
    booking_access: z.enum(["off", "calendar"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });

/**
 * Organization settings: interface language (LOC-001) and currency (LOC-006).
 *
 * The business type is here too, and it is the odd one out: language and
 * currency change what is recorded, while the type changes only what the
 * reports call things.
 *
 * The currency changes what new prices are recorded in; it deliberately does
 * not convert anything already stored. Section 8.8.1 is built on amounts that
 * mean what they meant when they were written, and silently restating a closed
 * visit at today's rate would break exactly that.
 */
export async function PATCH(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  // Section 6.1 gives organization_settings to the Owner alone.
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot change organization settings", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  if (parsed.data.slug) {
    const problem = checkSlug(parsed.data.slug);
    if (problem) {
      return apiError(422, "INVALID_SLUG", "The public booking slug cannot be used", id, {
        fieldErrors: [{ field: "slug", code: problem, message: "Invalid public slug" }],
      });
    }
  }

  try {
    const updated = await withTenant(actor.organizationId, async (tx) => {
      const [before] = await tx
        .select({
          name: organizations.name,
          locale: organizations.locale,
          currency: organizations.currency,
          type: organizations.type,
          slug: organizations.slug,
          booking_access: organizations.bookingAccess,
          // Both reach money: one decides what counts as safe to withdraw, the
          // other the rate every fixed cost is spread at. A change to either
          // moves figures the owner will later be asked to explain, so it
          // belongs in the trail rather than only in the row.
          withdrawal_reserve_minor: organizations.withdrawalReserveMinor,
          practical_capacity_basis_points: organizations.practicalCapacityBasisPoints,
        })
        .from(organizations)
        .where(eq(organizations.id, actor.organizationId))
        .limit(1);

      const {
        booking_access: bookingAccess,
        withdrawal_reserve_minor: reserve,
        practical_capacity_basis_points: practicalCapacity,
        ...columns
      } = parsed.data;
      const [row] = await tx
        .update(organizations)
        .set({
          ...columns,
          ...(bookingAccess !== undefined ? { bookingAccess } : {}),
          ...(reserve !== undefined ? { withdrawalReserveMinor: reserve } : {}),
          ...(practicalCapacity !== undefined
            ? { practicalCapacityBasisPoints: practicalCapacity }
            : {}),
          updatedBy: actor.userId,
          updatedAt: new Date(),
          version: sql`${organizations.version} + 1`,
        })
        .where(eq(organizations.id, actor.organizationId))
        .returning({
          name: organizations.name,
          locale: organizations.locale,
          currency: organizations.currency,
          type: organizations.type,
          slug: organizations.slug,
          booking_access: organizations.bookingAccess,
          withdrawal_reserve_minor: organizations.withdrawalReserveMinor,
          practical_capacity_basis_points: organizations.practicalCapacityBasisPoints,
        });

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "organization.settings_changed",
        entityType: "organization",
        entityId: actor.organizationId,
        before,
        after: row,
        requestId: id,
      });

      return row;
    });

    return apiSuccess(updated, id);
  } catch (error) {
    if (isUniqueViolation(error, "organization_slug_idx")) {
      return apiError(409, "SLUG_TAKEN", "This public booking address is already used", id);
    }
    throw error;
  }
}
