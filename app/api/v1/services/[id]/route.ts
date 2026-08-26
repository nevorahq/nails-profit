import { asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { supportedLocales } from "@/i18n/messages";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";
import { loadServiceCosting } from "@/lib/service-costing";

const patchServiceSchema = z.object({
  // partialRecord: see the note in the services collection route.
  name: z.partialRecord(z.enum(supportedLocales), z.string().trim().min(1).max(200)).optional(),
  price_minor: z.int().min(0).nullable().optional(),
  duration_minutes: z.int().positive().nullable().optional(),
  currency: z.enum(["MDL", "EUR"]).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }
  if (!can(caller.membership.role, "services", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read services", requestIdentifier);
  }

  const { id } = await context.params;
  const url = new URL(request.url);
  const requestedSpecialist = url.searchParams.get("specialist_id");
  // Costing a service together with a chosen set of add-ons (SRV-003).
  const addOnIds = (url.searchParams.get("add_on_ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const result = await withTenant(caller.membership.organizationId, async (tx) => {
    const [service] = await tx.select().from(services).where(eq(services.id, id)).limit(1);
    if (!service) return null;

    const specialistId =
      requestedSpecialist ??
      (
        await tx
          .select({ id: specialists.id })
          .from(specialists)
          .where(isNull(specialists.archivedAt))
          .orderBy(asc(specialists.createdAt), asc(specialists.id))
          .limit(1)
      )[0]?.id ??
      null;

    return { service, costing: await loadServiceCosting(tx, service, { specialistId, addOnIds }) };
  });

  if (!result) {
    return apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", requestIdentifier);
  }

  return apiSuccess(serialize(result.service, result.costing), requestIdentifier);
}

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
  // Editing an existing service is not the same permission as adding one: a
  // Master may add, and `create_only` is what stops that from becoming the
  // ability to rewrite the prices everyone else is costed against.
  if (!canManageCatalogue(actor.role, "services")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage services", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = patchServiceSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;

  const updated = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx.select().from(services).where(eq(services.id, id)).limit(1);
    if (!existing) return null;

    const [service] = await tx
      .update(services)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.price_minor !== undefined ? { priceMinor: parsed.data.price_minor } : {}),
        ...(parsed.data.duration_minutes !== undefined
          ? { durationMinutes: parsed.data.duration_minutes }
          : {}),
        ...(parsed.data.currency ? { currency: parsed.data.currency } : {}),
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${services.version} + 1`,
      })
      .where(eq(services.id, id))
      .returning();

    // Price and duration are financial inputs, so the change is audited with
    // both sides — the roadmap asks for audit events on financial changes.
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "service.updated",
      entityType: "service",
      entityId: service.id,
      before: { price_minor: existing.priceMinor, duration_minutes: existing.durationMinutes },
      after: { price_minor: service.priceMinor, duration_minutes: service.durationMinutes },
      requestId: requestIdentifier,
    });

    await recordCompletedServiceCostEvents(tx, actor);

    const specialistId =
      (
        await tx
          .select({ id: specialists.id })
          .from(specialists)
          .where(isNull(specialists.archivedAt))
          .orderBy(asc(specialists.createdAt), asc(specialists.id))
          .limit(1)
      )[0]?.id ?? null;

    return { service, costing: await loadServiceCosting(tx, service, { specialistId }) };
  });

  if (!updated) {
    return apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", requestIdentifier);
  }

  return apiSuccess(serialize(updated.service, updated.costing), requestIdentifier);
}

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
  // Editing an existing service is not the same permission as adding one: a
  // Master may add, and `create_only` is what stops that from becoming the
  // ability to rewrite the prices everyone else is costed against.
  if (!canManageCatalogue(actor.role, "services")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage services", requestIdentifier);
  }

  const { id } = await context.params;

  const archived = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx.select().from(services).where(eq(services.id, id)).limit(1);
    if (!existing || existing.archivedAt) return null;

    const [service] = await tx
      .update(services)
      .set({ archivedAt: new Date(), updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(services.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "service.archived",
      entityType: "service",
      entityId: service.id,
      before: { name: existing.name },
      after: { archived: true },
      requestId: requestIdentifier,
    });

    await recordCompletedServiceCostEvents(tx, actor);

    return service;
  });

  if (!archived) {
    return apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", requestIdentifier);
  }

  return apiSuccess({ id: archived.id }, requestIdentifier);
}

function serialize(
  service: typeof services.$inferSelect,
  costing: Awaited<ReturnType<typeof loadServiceCosting>>,
) {
  return {
    id: service.id,
    name: service.name,
    price_minor: service.priceMinor,
    duration_minutes: service.durationMinutes,
    currency: service.currency,
    version: service.version,
    costing:
      costing.status === "complete"
        ? {
            status: "complete",
            formula_version: costing.costing.formulaVersion,
            currency: costing.currency,
            price_minor: costing.costing.priceMinor,
            commission_minor: costing.costing.commissionMinor,
            contribution_margin_minor: costing.costing.contributionMarginMinor,
            margin_basis_points: costing.costing.marginBasisPoints,
            profit_per_hour_minor: costing.costing.profitPerHourMinor,
            explanation: costing.costing.explanation,
          }
        : { status: "incomplete", reasons: costing.reasons },
  };
}
