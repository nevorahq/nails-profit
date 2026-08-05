import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import {
  consumptions,
  financialSnapshots,
  specialists,
  visitLines,
  visits,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { buildVisitDraft, recalculateVisitProfit, writeFinancialSnapshot } from "@/lib/visit-service";

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
            commission_minor: snapshot.commissionMinor,
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

  const result = await withTenant(actor.organizationId, async (tx) => {
    // A Master may only record their own visits (section 6.1, scope "own").
    if (scopeFor(actor.role, "bookings") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, actor.userId))
        .limit(1);
      if (!own || own.id !== parsed.data.specialist_id) return { failure: "FORBIDDEN_SPECIALIST" as const };
    }

    const draft = await buildVisitDraft(tx, {
      serviceId: parsed.data.service_id,
      addOnIds: parsed.data.add_on_ids,
      specialistId: parsed.data.specialist_id,
      at: completedAt,
    });
    if (!draft) return { failure: "SERVICE_NOT_FOUND" as const };
    if (!draft.commission) return { failure: "MISSING_COMMISSION_RULE" as const };
    if (draft.plannedDurationMinutes <= 0) return { failure: "MISSING_DURATION" as const };

    const [visit] = await tx
      .insert(visits)
      .values({
        organizationId: actor.organizationId,
        clientId: parsed.data.client_id ?? null,
        specialistId: parsed.data.specialist_id,
        serviceId: parsed.data.service_id,
        completedAt,
        plannedDurationMinutes: draft.plannedDurationMinutes,
        actualDurationMinutes: parsed.data.actual_duration_minutes ?? null,
        commissionType: draft.commission.type,
        commissionBasisPoints: draft.commission.basisPoints,
        commissionFixedAmountMinor: draft.commission.fixedAmountMinor,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await tx.insert(visitLines).values(
      draft.lines.map((line) => ({
        organizationId: actor.organizationId,
        visitId: visit.id,
        kind: line.kind,
        serviceId: line.serviceId,
        addOnId: line.addOnId,
        nameSnapshot: line.nameSnapshot,
        priceMinor: line.priceMinor,
        discountMinor: line.discountMinor,
        durationMinutes: line.durationMinutes,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })),
    );

    const actualByMaterial = new Map(
      parsed.data.consumption.map((entry) => [entry.material_id, toMilliUnits(entry.actual_quantity)]),
    );

    if (draft.consumptions.length > 0) {
      await tx.insert(consumptions).values(
        draft.consumptions.map((line) => ({
          organizationId: actor.organizationId,
          visitId: visit.id,
          materialId: line.materialId,
          materialNameSnapshot: line.materialNameSnapshot,
          baseUnitSnapshot: line.baseUnitSnapshot,
          normativeQuantityMilliUnits: line.normativeQuantityMilliUnits,
          actualQuantityMilliUnits: actualByMaterial.get(line.materialId) ?? null,
          packagePriceMinorSnapshot: line.packagePriceMinorSnapshot,
          packageSizeMilliUnitsSnapshot: line.packageSizeMilliUnitsSnapshot,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })),
      );
    }

    const recalculated = await recalculateVisitProfit(tx, visit.id);
    const snapshot = await writeFinancialSnapshot(tx, {
      organizationId: actor.organizationId,
      visitId: visit.id,
      profit: recalculated!.profit,
      currency: draft.currency,
      actorUserId: actor.userId,
    });

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "visit.completed",
      entityType: "visit",
      entityId: visit.id,
      after: { revenue_minor: snapshot.revenueMinor, snapshot_version: snapshot.snapshotVersion },
      requestId: id,
    });

    await recordPilotProductEvent(tx, {
      organizationId: actor.organizationId,
      eventName: "visit_completed",
      actorUserId: actor.userId,
      actorRole: actor.role,
      source: "api",
      entityType: "visit",
      entityId: visit.id,
      metadata: { complete_margin: snapshot.incompleteReasons.length === 0 },
    });

    // This mirrors `loadOnboarding`: the guided workflow is complete after the
    // first financial snapshot. Whether its margin is complete remains visible
    // in the visit event and is a separate Gate 6 financial-quality criterion.
    await recordPilotProductEvent(tx, {
      organizationId: actor.organizationId,
      eventName: "onboarding_completed",
      actorUserId: actor.userId,
      actorRole: actor.role,
      source: "api",
      entityType: "organization",
      entityId: actor.organizationId,
    });

    return { visit, snapshot };
  });

  if ("failure" in result) {
    switch (result.failure) {
      case "SERVICE_NOT_FOUND":
        return apiError(404, "SERVICE_NOT_FOUND", "No service with this ID", id);
      case "MISSING_COMMISSION_RULE":
        // Refusing beats recording a visit whose commission would read as zero.
        return apiError(422, "MISSING_COMMISSION_RULE", "The specialist has no commission rule", id);
      case "MISSING_DURATION":
        return apiError(422, "MISSING_DURATION", "The service has no duration", id);
      case "FORBIDDEN_SPECIALIST":
        return apiError(403, "FORBIDDEN", "This role may only record its own visits", id);
    }
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
        incomplete_reasons: result.snapshot.incompleteReasons,
      },
    },
    id,
    201,
  );
}
