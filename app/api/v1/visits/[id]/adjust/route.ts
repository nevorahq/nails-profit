import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { consumptions, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recalculateVisitProfit, writeFinancialSnapshot } from "@/lib/visit-service";

/**
 * Versioned correction of a closed visit, spec section 12.2 and 8.8.1.
 *
 * Records what was actually used and how long it took, then writes a *new*
 * financial snapshot. The previous one is untouched — that is what makes a
 * correction auditable rather than a quiet rewrite, and what Gate 3 asks for.
 *
 * Prices, names and the commission are not adjustable here on purpose: changing
 * them would make the visit disagree with what the client paid. Only the two
 * facts the master observes can be corrected.
 */
const adjustSchema = z.object({
  consumption: z
    .array(z.object({ material_id: z.uuid(), actual_quantity: z.number().min(0).nullable() }))
    .max(100)
    .default([]),
  actual_duration_minutes: z.int().positive().nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

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
  if (!can(actor.role, "bookings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot adjust visits", requestIdentifier);
  }

  const body = await request.json().catch(() => null);
  const parsed = adjustSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [visit] = await tx.select().from(visits).where(eq(visits.id, id)).limit(1);
    if (!visit) return { failure: "NOT_FOUND" as const };

    if (scopeFor(actor.role, "bookings") === "own") {
      const { specialists } = await import("@/db/schema");
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, actor.userId))
        .limit(1);
      if (!own || own.id !== visit.specialistId) return { failure: "FORBIDDEN" as const };
    }

    const before = await recalculateVisitProfit(tx, visit.id);

    for (const entry of parsed.data.consumption) {
      await tx
        .update(consumptions)
        .set({
          actualQuantityMilliUnits:
            entry.actual_quantity === null ? null : toMilliUnits(entry.actual_quantity),
          updatedBy: actor.userId,
          updatedAt: new Date(),
          version: sql`${consumptions.version} + 1`,
        })
        .where(and(eq(consumptions.visitId, visit.id), eq(consumptions.materialId, entry.material_id)));
    }

    if (parsed.data.actual_duration_minutes !== undefined) {
      await tx
        .update(visits)
        .set({
          actualDurationMinutes: parsed.data.actual_duration_minutes,
          // The status records that this visit is no longer as first closed.
          status: "adjusted",
          updatedBy: actor.userId,
          updatedAt: new Date(),
          version: sql`${visits.version} + 1`,
        })
        .where(eq(visits.id, visit.id));
    } else {
      await tx
        .update(visits)
        .set({ status: "adjusted", updatedBy: actor.userId, updatedAt: new Date(), version: sql`${visits.version} + 1` })
        .where(eq(visits.id, visit.id));
    }

    const after = await recalculateVisitProfit(tx, visit.id);
    const snapshot = await writeFinancialSnapshot(tx, {
      organizationId: actor.organizationId,
      visitId: visit.id,
      profit: after!.profit,
      currency: "MDL",
      actorUserId: actor.userId,
    });

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "visit.adjusted",
      entityType: "visit",
      entityId: visit.id,
      before: {
        contribution_margin_minor:
          before?.profit.status === "complete" ? before.profit.costing.contributionMarginMinor : null,
      },
      after: {
        contribution_margin_minor: snapshot.contributionMarginMinor,
        snapshot_version: snapshot.snapshotVersion,
        reason: parsed.data.reason ?? null,
      },
      requestId: requestIdentifier,
    });

    return { snapshot };
  });

  if ("failure" in result) {
    return result.failure === "NOT_FOUND"
      ? apiError(404, "VISIT_NOT_FOUND", "No visit with this ID", requestIdentifier)
      : apiError(403, "FORBIDDEN", "This role may only adjust its own visits", requestIdentifier);
  }

  return apiSuccess(
    {
      snapshot_version: result.snapshot.snapshotVersion,
      revenue_minor: result.snapshot.revenueMinor,
      contribution_margin_minor: result.snapshot.contributionMarginMinor,
      profit_per_hour_minor: result.snapshot.profitPerHourMinor,
      incomplete_reasons: result.snapshot.incompleteReasons,
    },
    requestIdentifier,
    201,
  );
}
