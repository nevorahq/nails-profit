import { asc, isNull } from "drizzle-orm";
import { z } from "zod";

import { addOns } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { supportedLocales } from "@/i18n/messages";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Add-ons, spec SRV-003. Deltas rather than absolute values, and signed in both
 * directions: "короткая длина" may take less time and cost less, while "френч"
 * adds both. The recipe of an add-on lives under /add-ons/{id}/recipe.
 */
const addOnSchema = z.object({
  name: z
    .partialRecord(z.enum(supportedLocales), z.string().trim().min(1).max(200))
    .refine((value) => Object.keys(value).length > 0, { message: "At least one language is required" }),
  price_delta_minor: z.int().default(0),
  duration_delta_minutes: z.int().default(0),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "services", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read add-ons", id);
  }

  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx.select().from(addOns).where(isNull(addOns.archivedAt)).orderBy(asc(addOns.createdAt)),
  );

  return apiSuccess(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      price_delta_minor: row.priceDeltaMinor,
      duration_delta_minutes: row.durationDeltaMinutes,
    })),
    id,
  );
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "services")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage add-ons", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = addOnSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const addOn = await withTenant(actor.organizationId, async (tx) => {
    const [created] = await tx
      .insert(addOns)
      .values({
        organizationId: actor.organizationId,
        name: parsed.data.name,
        priceDeltaMinor: parsed.data.price_delta_minor,
        durationDeltaMinutes: parsed.data.duration_delta_minutes,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "add_on.created",
      entityType: "add_on",
      entityId: created.id,
      after: {
        price_delta_minor: created.priceDeltaMinor,
        duration_delta_minutes: created.durationDeltaMinutes,
      },
      requestId: id,
    });

    return created;
  });

  return apiSuccess({ id: addOn.id, name: addOn.name }, id, 201);
}
