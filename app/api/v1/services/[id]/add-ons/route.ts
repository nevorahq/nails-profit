import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { addOns, serviceAddOns, services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/** Replaces the set of add-ons offered with a service (section 11.2, M:N). */
const linkSchema = z.object({ add_on_ids: z.array(z.uuid()).max(50) });

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
  if (!canManageCatalogue(actor.role, "services")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage services", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;
  const requested = [...new Set(parsed.data.add_on_ids)];

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [service] = await tx.select().from(services).where(eq(services.id, id)).limit(1);
    if (!service) return { failure: "SERVICE_NOT_FOUND" as const };

    if (requested.length > 0) {
      // RLS already hides another tenant's add-ons, so a short count means at
      // least one id does not belong here. Rejecting outright beats silently
      // linking a subset.
      const found = await tx.select({ id: addOns.id }).from(addOns).where(inArray(addOns.id, requested));
      if (found.length !== requested.length) return { failure: "ADD_ON_NOT_FOUND" as const };
    }

    await tx.delete(serviceAddOns).where(eq(serviceAddOns.serviceId, service.id));

    if (requested.length > 0) {
      await tx.insert(serviceAddOns).values(
        requested.map((addOnId) => ({
          organizationId: actor.organizationId,
          serviceId: service.id,
          addOnId,
        })),
      );
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "service.add_ons_updated",
      entityType: "service",
      entityId: service.id,
      after: { add_on_ids: requested },
      requestId: requestIdentifier,
    });

    return { linked: requested.length };
  });

  if ("failure" in result) {
    return result.failure === "SERVICE_NOT_FOUND"
      ? apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", requestIdentifier)
      : apiError(404, "ADD_ON_NOT_FOUND", "One of the add-ons does not exist", requestIdentifier);
  }

  return apiSuccess({ linked: result.linked }, requestIdentifier);
}
