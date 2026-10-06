import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { chairRents, organizations, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { planRuleChange, RULE_CHANGE_REFUSALS } from "@/domain/rule-change";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * What a master renting a chair pays the studio each month.
 *
 * Owner-only through `expenses`, reading included, like a salary: it is what
 * one person pays, and it is the studio's income in the same report the ledger
 * feeds. Versioned rather than edited — a new amount closes the one in force
 * at the instant it starts, so a month already reported keeps its rent.
 */
const rentShape = z.object({
  amount_minor: z.int().min(0),
  /** The studio's day the amount takes over from, `YYYY-MM-DD`; absent is now. */
  effective_date: z.iso.date().optional(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }
  if (!can(caller.membership.role, "expenses", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read chair rent", reqId);
  }

  const { id } = await context.params;
  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx
      .select({
        id: chairRents.id,
        amount_minor: chairRents.amountMinor,
        active_from: chairRents.activeFrom,
        active_to: chairRents.activeTo,
      })
      .from(chairRents)
      .where(eq(chairRents.specialistId, id))
      .orderBy(asc(chairRents.activeFrom), asc(chairRents.createdAt)),
  );

  return apiSuccess(rows, reqId);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "expenses")) {
    return apiError(403, "FORBIDDEN", "This role cannot set chair rent", reqId);
  }

  const body = await request.json().catch(() => null);
  const parsed = rentShape.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", reqId, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [person] = await tx
      .select({ id: specialists.id, cooperationType: specialists.cooperationType })
      .from(specialists)
      .where(and(eq(specialists.id, id), isNull(specialists.archivedAt)))
      .limit(1);
    if (!person) return { failure: "SPECIALIST_NOT_FOUND" as const };
    // Rent from a master on a percentage would be counted beside visits that
    // are already the studio's revenue — the same chair paid for twice.
    if (person.cooperationType !== "rent") return { failure: "NOT_A_RENTER" as const };

    const [organization] = await tx
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId));
    // Locked, so that two changes sent at once cannot both close the same rent.
    const current = await tx
      .select({ id: chairRents.id, activeFrom: chairRents.activeFrom })
      .from(chairRents)
      .where(and(eq(chairRents.specialistId, id), isNull(chairRents.activeTo)))
      .for("update");

    const plan = planRuleChange({
      current,
      effectiveDate: parsed.data.effective_date,
      now: new Date(),
      timezone: organization.timezone,
    });
    if (!plan.ok) return { failure: "RULE_CHANGE" as const, reason: plan.reason };

    if (plan.close.ids.length > 0) {
      await tx
        .update(chairRents)
        .set({ activeTo: plan.close.activeTo, updatedBy: actor.userId, updatedAt: new Date() })
        .where(inArray(chairRents.id, [...plan.close.ids]));
    }

    const [row] = await tx
      .insert(chairRents)
      .values({
        organizationId: actor.organizationId,
        specialistId: id,
        amountMinor: parsed.data.amount_minor,
        activeFrom: plan.open.activeFrom,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "chair_rent.created",
      entityType: "chair_rent",
      entityId: row.id,
      after: { specialist_id: id, amount_minor: row.amountMinor, active_from: row.activeFrom },
      requestId: reqId,
    });

    return { row };
  });

  if ("failure" in result) {
    if (result.failure === "RULE_CHANGE") {
      const refusal = RULE_CHANGE_REFUSALS[result.reason];
      return apiError(422, refusal.code, refusal.message, reqId, {
        fieldErrors: [{ field: "effective_date", code: result.reason, message: refusal.message }],
      });
    }
    return result.failure === "NOT_A_RENTER"
      ? apiError(422, "NOT_A_RENTER", "Rent is set only for a master renting a chair", reqId)
      : apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", reqId);
  }

  return apiSuccess(
    {
      id: result.row.id,
      amount_minor: result.row.amountMinor,
      active_from: result.row.activeFrom,
      active_to: result.row.activeTo,
    },
    reqId,
    201,
  );
}
