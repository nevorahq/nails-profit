import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { laborCostRules, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Labour a month owes and no visit does: a master's salary, and what the
 * owner's own work is worth.
 *
 * Owner-only through the `expenses` capability, reading included — these rows
 * say what people earn, and «Оклад Марии» is as much Maria's business as a rent
 * cheque is the studio's. Section 6.1 is explicit that hiding the section is
 * not access control, so every handler asks the matrix.
 */
const ruleShape = z
  .object({
    recipient: z.enum(["owner", "specialist"]),
    /** Required for a specialist, refused for the owner — the database agrees. */
    specialist_id: z.uuid().nullable().optional(),
    label: z.string().trim().max(200).optional(),
    basis: z.enum(["fixed_monthly", "percent_revenue"]),
    amount_minor: z.int().min(0).optional(),
    /** 1500 = 15% of the month's revenue. */
    basis_points: z.int().min(0).max(10_000).optional(),
    payroll_tax_basis_points: z.int().min(0).max(10_000).optional(),
    active_from: z.iso.datetime().optional(),
  })
  .refine(
    (value) =>
      value.basis === "fixed_monthly"
        ? value.amount_minor !== undefined && value.basis_points === undefined
        : value.basis_points !== undefined && value.amount_minor === undefined,
    { message: "A monthly rule needs an amount; a percentage rule needs a rate" },
  )
  .refine((value) => (value.recipient === "specialist") === Boolean(value.specialist_id), {
    message: "A specialist rule needs a specialist, and an owner rule cannot have one",
  });

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "expenses", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read labour costs", id);
  }

  // Superseded rules stay — a month in the past is still costed by the rule
  // that was true in it — so the list carries `active_to` and lets the reader
  // see the history rather than pretending only the current row exists.
  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx
      .select({
        id: laborCostRules.id,
        recipient: laborCostRules.recipient,
        specialist_id: laborCostRules.specialistId,
        label: laborCostRules.label,
        basis: laborCostRules.basis,
        amount_minor: laborCostRules.amountMinor,
        basis_points: laborCostRules.basisPoints,
        payroll_tax_basis_points: laborCostRules.payrollTaxBasisPoints,
        active_from: laborCostRules.activeFrom,
        active_to: laborCostRules.activeTo,
      })
      .from(laborCostRules)
      .orderBy(asc(laborCostRules.activeFrom), asc(laborCostRules.createdAt)),
  );

  return apiSuccess(rows, id);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "expenses")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage labour costs", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = ruleShape.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const data = parsed.data;
  const activeFrom = data.active_from ? new Date(data.active_from) : new Date();

  const created = await withTenant(actor.organizationId, async (tx) => {
    if (data.specialist_id) {
      const [person] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(and(eq(specialists.id, data.specialist_id), isNull(specialists.archivedAt)))
        .limit(1);
      if (!person) return null;
    }

    /*
     * Writing a rule closes the one it replaces rather than editing it.
     *
     * A raise is a new row: January has to keep reporting January's salary, and
     * that is only possible if January's rule still exists. Closing the old one
     * at the same instant is also what keeps `selectLaborRules` from having two
     * live rows for one person, which would pay them twice.
     */
    await tx
      .update(laborCostRules)
      .set({ activeTo: activeFrom, updatedBy: actor.userId, updatedAt: new Date() })
      .where(
        and(
          eq(laborCostRules.recipient, data.recipient),
          data.specialist_id
            ? eq(laborCostRules.specialistId, data.specialist_id)
            : isNull(laborCostRules.specialistId),
          isNull(laborCostRules.activeTo),
        ),
      );

    const [row] = await tx
      .insert(laborCostRules)
      .values({
        organizationId: actor.organizationId,
        recipient: data.recipient,
        specialistId: data.specialist_id ?? null,
        label: data.label ?? null,
        basis: data.basis,
        amountMinor: data.amount_minor ?? null,
        basisPoints: data.basis_points ?? null,
        payrollTaxBasisPoints: data.payroll_tax_basis_points ?? 0,
        activeFrom,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "labor_cost.created",
      entityType: "labor_cost_rule",
      entityId: row.id,
      after: {
        recipient: row.recipient,
        basis: row.basis,
        amount_minor: row.amountMinor,
        basis_points: row.basisPoints,
        active_from: row.activeFrom,
      },
      requestId: id,
    });

    return row;
  });

  if (!created) {
    return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", id);
  }

  return apiSuccess(
    {
      id: created.id,
      recipient: created.recipient,
      specialist_id: created.specialistId,
      label: created.label,
      basis: created.basis,
      amount_minor: created.amountMinor,
      basis_points: created.basisPoints,
      payroll_tax_basis_points: created.payrollTaxBasisPoints,
      active_from: created.activeFrom,
      active_to: created.activeTo,
    },
    id,
    201,
  );
}
