import { asc, isNull } from "drizzle-orm";
import { z } from "zod";

import { services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { supportedLocales } from "@/i18n/messages";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";
import { loadServiceCosting } from "@/lib/service-costing";

// partialRecord, not record: `z.record` with an enum key demands every locale,
// which would force a Russian-only salon to invent Romanian and English names.
// LocalizedText is deliberately partial and `resolveLocalizedText` handles the
// fallback (LOC-008).
const localizedName = z
  .partialRecord(z.enum(supportedLocales), z.string().trim().min(1).max(200))
  .refine((value) => Object.keys(value).length > 0, { message: "At least one language is required" });

const createServiceSchema = z.object({
  name: localizedName,
  price_minor: z.int().min(0).nullable().optional(),
  duration_minutes: z.int().positive().nullable().optional(),
  currency: z.enum(["MDL", "EUR"]).default("MDL"),
});

/** The first specialist, used to resolve a commission when none was requested. */
async function defaultSpecialistId(tx: Parameters<typeof loadServiceCosting>[0]) {
  const [specialist] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(isNull(specialists.archivedAt))
    .orderBy(asc(specialists.createdAt), asc(specialists.id))
    .limit(1);
  return specialist?.id ?? null;
}

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "services", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read services", id);
  }

  const requestedSpecialist = new URL(request.url).searchParams.get("specialist_id");

  const rows = await withTenant(caller.membership.organizationId, async (tx) => {
    const specialistId = requestedSpecialist ?? (await defaultSpecialistId(tx));
    const catalogue = await tx
      .select()
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    return Promise.all(
      catalogue.map(async (service) => {
        const costing = await loadServiceCosting(tx, service, { specialistId });
        return { service, costing };
      }),
    );
  });

  return apiSuccess(
    rows.map(({ service, costing }) => ({
      id: service.id,
      name: service.name,
      price_minor: service.priceMinor,
      duration_minutes: service.durationMinutes,
      currency: service.currency,
      costing:
        costing.status === "complete"
          ? {
              status: "complete",
              contribution_margin_minor: costing.costing.contributionMarginMinor,
              margin_basis_points: costing.costing.marginBasisPoints,
              profit_per_hour_minor: costing.costing.profitPerHourMinor,
              commission_minor: costing.costing.commissionMinor,
            }
          : { status: "incomplete", reasons: costing.reasons },
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
  if (!can(actor.role, "services", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage services", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createServiceSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const service = await withTenant(actor.organizationId, async (tx) => {
    const [created] = await tx
      .insert(services)
      .values({
        organizationId: actor.organizationId,
        name: parsed.data.name,
        priceMinor: parsed.data.price_minor ?? null,
        durationMinutes: parsed.data.duration_minutes ?? null,
        currency: parsed.data.currency,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "service.created",
      entityType: "service",
      entityId: created.id,
      after: { price_minor: created.priceMinor, duration_minutes: created.durationMinutes },
      requestId: id,
    });

    await recordCompletedServiceCostEvents(tx, actor);

    return created;
  });

  return apiSuccess({ id: service.id, name: service.name }, id, 201);
}
