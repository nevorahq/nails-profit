import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { services, specialistServices, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Which services a specialist performs, and how long they take *them*.
 *
 * The duration override is why this endpoint is not a list of ids: the same
 * service takes a beginner longer than the master who trained them, and a slot
 * search that ignores the difference either overbooks one or wastes the other's
 * day. Absent, the service's own duration applies.
 *
 * `requires_workplace` sits here rather than on the service because whether a
 * chair is occupied is a property of how the work is done at this studio.
 */
const entrySchema = z.object({
  service_id: z.uuid(),
  duration_minutes: z.int().positive().max(720).nullable().optional(),
  requires_workplace: z.boolean().optional(),
});

const linkSchema = z.object({ services: z.array(entrySchema).max(200) });

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
    return apiError(403, "FORBIDDEN", "This role cannot manage specialist services", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const entries = parsed.data.services;
  const ids = entries.map((entry) => entry.service_id);
  if (new Set(ids).size !== ids.length) {
    return apiError(422, "DUPLICATE_SERVICE", "A service may appear only once", requestIdentifier);
  }

  const { id } = await context.params;

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [specialist] = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(eq(specialists.id, id))
      .limit(1);
    if (!specialist) return { failure: "SPECIALIST_NOT_FOUND" as const };

    if (ids.length > 0) {
      const found = await tx.select({ id: services.id }).from(services).where(inArray(services.id, ids));
      if (found.length !== ids.length) return { failure: "SERVICE_NOT_FOUND" as const };
    }

    await tx.delete(specialistServices).where(eq(specialistServices.specialistId, specialist.id));

    if (entries.length > 0) {
      await tx.insert(specialistServices).values(
        entries.map((entry) => ({
          organizationId: actor.organizationId,
          specialistId: specialist.id,
          serviceId: entry.service_id,
          durationOverrideMinutes: entry.duration_minutes ?? null,
          requiresWorkplace: entry.requires_workplace ?? false,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })),
      );
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "specialist.services_replaced",
      entityType: "specialist",
      entityId: specialist.id,
      after: { services: entries.length },
      requestId: requestIdentifier,
    });

    return { linked: entries.length };
  });

  if ("failure" in outcome) {
    return outcome.failure === "SPECIALIST_NOT_FOUND"
      ? apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", requestIdentifier)
      : apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", requestIdentifier);
  }

  return apiSuccess({ specialist_id: id, services: outcome.linked }, requestIdentifier);
}
