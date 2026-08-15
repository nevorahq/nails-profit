import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { commissionRuleServices, commissionRules, services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { commissionBases, commissionTypes } from "@/domain/costing";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";

/**
 * Adds a commission rule, spec RES-005 and CST-009.
 *
 * Rules are versioned, never edited. A new rule closes the previous one for the
 * same scope by setting its `active_to` to the new rule's `active_from`, which
 * hands over cleanly — `active_from` is inclusive and `active_to` exclusive, so
 * there is neither a gap nor an overlap. Asking about a past date still resolves
 * to the rule that applied then, which is what keeps finished visits stable.
 */
const ruleSchema = z
  .object({
    type: z.enum(commissionTypes),
    basis_points: z.int().min(0).max(10_000).optional(),
    fixed_amount_minor: z.int().min(0).optional(),
    /** Null or absent makes this the specialist's default rule. */
    service_id: z.uuid().nullable().optional(),
    /** What the percentage applies to. Absent keeps the historical behaviour. */
    base: z.enum(commissionBases).optional(),
    /**
     * The services this rule pays on. Empty or absent means all of them, which
     * is what every rule written before this did.
     */
    covered_service_ids: z.array(z.uuid()).max(200).optional(),
  })
  .refine(
    (value) => {
      // The same three shapes the database enforces, refused here first so the
      // caller gets a field error rather than a constraint violation.
      if (value.type === "fixed") {
        return value.fixed_amount_minor !== undefined && value.basis_points === undefined;
      }
      if (value.type === "hybrid") {
        return value.fixed_amount_minor !== undefined && value.basis_points !== undefined;
      }
      return value.basis_points !== undefined && value.fixed_amount_minor === undefined;
    },
    {
      message:
        "A fixed rule needs an amount, a percentage rule needs a rate, and a hybrid needs both",
    },
  );

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  // A master must not edit the rule they are paid by; see canManageCatalogue.
  if (!canManageCatalogue(actor.role, "commissions")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage commission rules", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;
  const serviceId = parsed.data.service_id ?? null;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [specialist] = await tx.select().from(specialists).where(eq(specialists.id, id)).limit(1);
    if (!specialist) return { failure: "SPECIALIST_NOT_FOUND" as const };

    if (serviceId) {
      const [service] = await tx.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).limit(1);
      if (!service) return { failure: "SERVICE_NOT_FOUND" as const };
    }

    const activeFrom = new Date();

    // Close the open rule of the same scope. Past queries still resolve to it,
    // because active_to only ends it from this instant forward.
    await tx
      .update(commissionRules)
      .set({ activeTo: activeFrom, updatedBy: actor.userId, updatedAt: activeFrom, version: sql`${commissionRules.version} + 1` })
      .where(
        and(
          eq(commissionRules.specialistId, specialist.id),
          serviceId === null
            ? isNull(commissionRules.serviceId)
            : eq(commissionRules.serviceId, serviceId),
          isNull(commissionRules.activeTo),
        ),
      );

    const [rule] = await tx
      .insert(commissionRules)
      .values({
        organizationId: actor.organizationId,
        specialistId: specialist.id,
        serviceId,
        type: parsed.data.type,
        basisPoints: parsed.data.basis_points ?? null,
        fixedAmountMinor: parsed.data.fixed_amount_minor ?? null,
        base: parsed.data.base ?? "after_discount",
        activeFrom,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    /*
     * The services the rule pays on, if it does not pay on all of them.
     *
     * Written after the rule and inside the same transaction, so a rule can
     * never exist with half a list — a visit closed against it would then pay
     * on the wrong lines and the snapshot would preserve the mistake.
     */
    const coveredIds = [...new Set(parsed.data.covered_service_ids ?? [])];
    if (coveredIds.length > 0) {
      const known = await tx
        .select({ id: services.id })
        .from(services)
        .where(inArray(services.id, coveredIds));
      if (known.length !== coveredIds.length) return { failure: "SERVICE_NOT_FOUND" as const };

      await tx.insert(commissionRuleServices).values(
        coveredIds.map((serviceId) => ({
          organizationId: actor.organizationId,
          commissionRuleId: rule.id,
          serviceId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })),
      );
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "commission_rule.created",
      entityType: "commission_rule",
      entityId: rule.id,
      after: {
        specialist_id: specialist.id,
        service_id: serviceId,
        type: rule.type,
        basis_points: rule.basisPoints,
        fixed_amount_minor: rule.fixedAmountMinor,
        base: rule.base,
        covered_service_ids: coveredIds,
      },
      requestId: requestIdentifier,
    });

    await recordCompletedServiceCostEvents(tx, actor);

    return { rule };
  });

  if ("failure" in result) {
    return result.failure === "SPECIALIST_NOT_FOUND"
      ? apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", requestIdentifier)
      : apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", requestIdentifier);
  }

  return apiSuccess(
    {
      id: result.rule.id,
      type: result.rule.type,
      basis_points: result.rule.basisPoints,
      fixed_amount_minor: result.rule.fixedAmountMinor,
      base: result.rule.base,
      service_id: result.rule.serviceId,
      active_from: result.rule.activeFrom,
    },
    requestIdentifier,
    201,
  );
}
