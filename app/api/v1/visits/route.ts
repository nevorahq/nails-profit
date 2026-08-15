import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { financialSnapshots, specialists, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { fingerprintOf } from "@/lib/idempotency";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedVisit, VISIT_FAILURES } from "@/lib/visit-service";

/**
 * Manually recorded completed visits, roadmap phase 3.
 *
 * Creating one snapshots the catalogue: prices, names, the recipe and the
 * commission rule are copied in, and the visit never reads the catalogue again.
 */
const createVisitSchema = z.object({
  service_id: z.uuid(),
  specialist_id: z.uuid(),
  client_id: z.uuid().nullable().optional(),
  add_on_ids: z.array(z.uuid()).max(50).default([]),
  completed_at: z.iso.datetime().optional(),
  actual_duration_minutes: z.int().positive().nullable().optional(),
  /**
   * Omitted takes the studio's default method; an explicit null means cash.
   * The distinction matters: a studio that usually takes cards should not have
   * to think about the field, and the one client who paid in notes has to be
   * recordable without a fee the bank never charged.
   */
  payment_method_id: z.uuid().nullable().optional(),
  /** Actual use per material; anything omitted stays unrecorded, never zero. */
  consumption: z
    .array(z.object({ material_id: z.uuid(), actual_quantity: z.number().min(0) }))
    .max(100)
    .default([]),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read visits", id);
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const specialistFilter = url.searchParams.get("specialist_id");

  const rows = await withTenant(actor.organizationId, async (tx) => {
    // Section 6.1: a Master sees only their own visits. Enforced by matching the
    // specialist row that carries their user id, not by trusting a query param.
    let ownSpecialistId: string | null = null;
    if (scopeFor(actor.role, "bookings") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, actor.userId))
        .limit(1);
      ownSpecialistId = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    const conditions = [
      from ? gte(visits.completedAt, new Date(from)) : undefined,
      to ? lte(visits.completedAt, new Date(to)) : undefined,
      ownSpecialistId
        ? eq(visits.specialistId, ownSpecialistId)
        : specialistFilter
          ? eq(visits.specialistId, specialistFilter)
          : undefined,
    ].filter(Boolean);

    const found = await tx
      .select()
      .from(visits)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(visits.completedAt));

    return Promise.all(
      found.map(async (visit) => {
        // The latest snapshot is the visit's current financial truth; earlier
        // versions stay for the audit trail.
        const [snapshot] = await tx
          .select()
          .from(financialSnapshots)
          .where(eq(financialSnapshots.visitId, visit.id))
          .orderBy(desc(financialSnapshots.snapshotVersion))
          .limit(1);
        const lines = await tx.select().from(visitLines).where(eq(visitLines.visitId, visit.id));
        return { visit, snapshot, lines };
      }),
    );
  });

  return apiSuccess(
    rows.map(({ visit, snapshot, lines }) => ({
      id: visit.id,
      completed_at: visit.completedAt,
      specialist_id: visit.specialistId,
      client_id: visit.clientId,
      status: visit.status,
      lines: lines.map((line) => ({ kind: line.kind, name: line.nameSnapshot, price_minor: line.priceMinor })),
      snapshot: snapshot
        ? {
            version: snapshot.snapshotVersion,
            revenue_minor: snapshot.revenueMinor,
            material_cost_minor: snapshot.materialCostMinor,
            material_usage_source: snapshot.materialUsageSource,
            commission_minor: snapshot.commissionMinor,
            // Null on anything written under `costing-v1`, and null rather than
            // zero on purpose: nobody was asked about VAT then.
            net_revenue_minor: snapshot.netRevenueMinor,
            vat_minor: snapshot.vatMinor,
            turnover_tax_minor: snapshot.turnoverTaxMinor,
            payment_commission_minor: snapshot.paymentCommissionMinor,
            payroll_tax_minor: snapshot.payrollTaxMinor,
            contribution_margin_minor: snapshot.contributionMarginMinor,
            margin_basis_points: snapshot.marginBasisPoints,
            profit_per_hour_minor: snapshot.profitPerHourMinor,
            estimated_duration: snapshot.estimatedDuration,
            incomplete_reasons: snapshot.incompleteReasons,
          }
        : null,
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
  if (!can(actor.role, "bookings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot record visits", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createVisitSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const completedAt = parsed.data.completed_at ? new Date(parsed.data.completed_at) : new Date();
  const completionKey = request.headers.get("idempotency-key")?.trim() || undefined;
  if (completionKey && completionKey.length > 200) {
    return apiError(422, "INVALID_IDEMPOTENCY_KEY", "The idempotency key is too long", id);
  }

  const result = await withTenant(actor.organizationId, async (tx) => {
    // A Master may only record their own visits (section 6.1, scope "own").
    if (scopeFor(actor.role, "bookings") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, actor.userId))
        .limit(1);
      if (!own || own.id !== parsed.data.specialist_id) return { ok: false as const, failure: "forbidden" as const };
    }

    return recordCompletedVisit(tx, {
      organizationId: actor.organizationId,
      actor: { userId: actor.userId, role: actor.role },
      serviceId: parsed.data.service_id,
      specialistId: parsed.data.specialist_id,
      clientId: parsed.data.client_id ?? null,
      addOnIds: parsed.data.add_on_ids,
      completedAt,
      actualDurationMinutes: parsed.data.actual_duration_minutes ?? null,
      // Passed straight through, undefined included: the service tells the two
      // apart, and collapsing them here would lose the difference.
      paymentMethodId: parsed.data.payment_method_id,
      consumption: parsed.data.consumption.map((entry) => ({
        materialId: entry.material_id,
        actualQuantityMilliUnits: toMilliUnits(entry.actual_quantity),
      })),
      requestId: id,
      completionKey,
      completionFingerprint: completionKey ? fingerprintOf(parsed.data) : undefined,
    });
  });

  if (!result.ok) {
    if (result.failure === "forbidden") {
      return apiError(403, "FORBIDDEN", "This role may only record its own visits", id);
    }
    const refusal = VISIT_FAILURES[result.failure];
    return apiError(refusal.status, refusal.code, refusal.message, id);
  }

  return apiSuccess(
    {
      id: result.visit.id,
      completed_at: result.visit.completedAt,
      snapshot: {
        version: result.snapshot.snapshotVersion,
        revenue_minor: result.snapshot.revenueMinor,
        contribution_margin_minor: result.snapshot.contributionMarginMinor,
        profit_per_hour_minor: result.snapshot.profitPerHourMinor,
        material_cost_minor: result.snapshot.materialCostMinor,
        material_usage_source: result.snapshot.materialUsageSource,
        incomplete_reasons: result.snapshot.incompleteReasons,
      },
    },
    id,
    result.replayed ? 200 : 201,
  );
}
