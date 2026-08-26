import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recalculateVisitProfit, writeFinancialSnapshot } from "@/lib/visit-service";

/**
 * Versioned correction of a closed visit, spec section 12.2 and 8.8.1.
 *
 * Records how long it actually took and what was given back, then writes a
 * *new* financial snapshot. The previous one is untouched — that is what makes
 * a correction auditable rather than a quiet rewrite, and what Gate 3 asks for.
 *
 * Prices, names and the commission are not adjustable here on purpose: changing
 * them would make the visit disagree with what the client paid.
 */
const adjustSchema = z.object({
  actual_duration_minutes: z.int().positive().nullable().optional(),
  /**
   * Money given back, per line.
   *
   * The one figure of the sale that is adjustable here, and it is not an
   * exception to the rule above: a refund does not restate what the client was
   * charged, it records something that happened afterwards. The price, the name
   * and the commission stay as they were.
   */
  refunds: z
    .array(z.object({ line_id: z.uuid(), refund_minor: z.int().min(0) }))
    .max(50)
    .default([]),
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
    const beforeRefunds = await tx
      .select({ id: visitLines.id, refundMinor: visitLines.refundMinor })
      .from(visitLines)
      .where(eq(visitLines.visitId, visit.id));

    /*
     * A refund larger than what the line took is refused by the database rather
     * than clamped here: `visit_line_refund_within_charged` is what keeps a
     * typo from turning a visit's revenue negative and every total above it
     * with it. The check runs inside this transaction, so a bad entry aborts
     * the correction instead of writing half of one.
     */
    for (const entry of parsed.data.refunds) {
      await tx
        .update(visitLines)
        .set({
          refundMinor: entry.refund_minor,
          updatedBy: actor.userId,
          updatedAt: new Date(),
          version: sql`${visitLines.version} + 1`,
        })
        .where(and(eq(visitLines.visitId, visit.id), eq(visitLines.id, entry.line_id)));
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
    const afterRefunds = await tx
      .select({ id: visitLines.id, refundMinor: visitLines.refundMinor })
      .from(visitLines)
      .where(eq(visitLines.visitId, visit.id));
    const snapshot = await writeFinancialSnapshot(tx, {
      organizationId: actor.organizationId,
      visitId: visit.id,
      profit: after!.profit,
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
        refunds: beforeRefunds,
      },
      after: {
        contribution_margin_minor: snapshot.contributionMarginMinor,
        snapshot_version: snapshot.snapshotVersion,
        reason: parsed.data.reason ?? null,
        refunds: afterRefunds,
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
