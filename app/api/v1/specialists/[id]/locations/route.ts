import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { locations, specialistLocations, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Which addresses a specialist works at, roadmap section 7.4.
 *
 * Replace-set, like the service add-on link: the request states the whole
 * truth, so removing an address is expressed by sending the list without it
 * rather than by a second call nobody remembers to make.
 */
const linkSchema = z.object({ location_ids: z.array(z.uuid()).max(20) });

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "bookings")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage specialist locations", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;
  const requested = [...new Set(parsed.data.location_ids)];

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [specialist] = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(eq(specialists.id, id))
      .limit(1);
    if (!specialist) return { failure: "SPECIALIST_NOT_FOUND" as const };

    if (requested.length > 0) {
      // RLS already hides another tenant's rows, so a short count here means an
      // unknown id rather than a permission problem.
      const found = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(inArray(locations.id, requested));
      if (found.length !== requested.length) return { failure: "LOCATION_NOT_FOUND" as const };
    }

    await tx.delete(specialistLocations).where(eq(specialistLocations.specialistId, specialist.id));

    if (requested.length > 0) {
      await tx.insert(specialistLocations).values(
        requested.map((locationId) => ({
          organizationId: actor.organizationId,
          specialistId: specialist.id,
          locationId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })),
      );
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "specialist.locations_replaced",
      entityType: "specialist",
      entityId: specialist.id,
      after: { location_ids: requested },
      requestId: requestIdentifier,
    });

    return { linked: requested.length };
  });

  if ("failure" in outcome) {
    return outcome.failure === "SPECIALIST_NOT_FOUND"
      ? apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", requestIdentifier)
      : apiError(404, "LOCATION_NOT_FOUND", "No location with this ID", requestIdentifier);
  }

  return apiSuccess({ specialist_id: id, location_ids: requested }, requestIdentifier);
}
