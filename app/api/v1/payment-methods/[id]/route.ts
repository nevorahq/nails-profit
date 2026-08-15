import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { paymentMethods } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Editing and retiring a payment method.
 *
 * PATCH is allowed here, unlike on `labor_cost_rule` and `tax_rule`, and the
 * difference is which figures it can reach: those two are resolved for the date
 * a visit closed, so editing one would rewrite a past month, while this rate is
 * copied into each visit at closing time and never read again. A new acquiring
 * contract is a correction of what the studio pays *from now*, which is exactly
 * what an edit means.
 *
 * DELETE archives. A method that paid for a year of visits still has to exist
 * for those visits' rows to point at.
 */
const patchShape = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(["cash", "card", "transfer", "other"]).optional(),
    commission_basis_points: z.int().min(0).max(10_000).optional(),
    fixed_fee_minor: z.int().min(0).optional(),
    is_default: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage payment methods", reqId);
  }

  const body = await request.json().catch(() => null);
  const parsed = patchShape.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", reqId, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;
  const data = parsed.data;

  const updated = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.archivedAt)))
      .limit(1);
    if (!existing) return null;

    if (data.is_default) {
      await tx
        .update(paymentMethods)
        .set({ isDefault: false, updatedBy: actor.userId, updatedAt: new Date() })
        .where(and(eq(paymentMethods.isDefault, true), isNull(paymentMethods.archivedAt)));
    }

    const [row] = await tx
      .update(paymentMethods)
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.kind !== undefined ? { kind: data.kind } : {}),
        ...(data.commission_basis_points !== undefined
          ? { commissionBasisPoints: data.commission_basis_points }
          : {}),
        ...(data.fixed_fee_minor !== undefined ? { fixedFeeMinor: data.fixed_fee_minor } : {}),
        ...(data.is_default !== undefined ? { isDefault: data.is_default } : {}),
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(paymentMethods.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "payment_method.updated",
      entityType: "payment_method",
      entityId: row.id,
      before: {
        commission_basis_points: existing.commissionBasisPoints,
        fixed_fee_minor: existing.fixedFeeMinor,
        is_default: existing.isDefault,
      },
      after: {
        commission_basis_points: row.commissionBasisPoints,
        fixed_fee_minor: row.fixedFeeMinor,
        is_default: row.isDefault,
      },
      requestId: reqId,
    });

    return row;
  });

  if (!updated) return apiError(404, "PAYMENT_METHOD_NOT_FOUND", "No payment method with this ID", reqId);

  return apiSuccess(
    {
      id: updated.id,
      name: updated.name,
      kind: updated.kind,
      commission_basis_points: updated.commissionBasisPoints,
      fixed_fee_minor: updated.fixedFeeMinor,
      is_default: updated.isDefault,
    },
    reqId,
  );
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage payment methods", reqId);
  }

  const { id } = await context.params;

  const archived = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.archivedAt)))
      .limit(1);
    if (!existing) return null;

    const [row] = await tx
      .update(paymentMethods)
      // The default flag goes with it: leaving it set would keep an archived
      // method as the one new visits are costed at.
      .set({
        archivedAt: new Date(),
        isDefault: false,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(paymentMethods.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "payment_method.archived",
      entityType: "payment_method",
      entityId: row.id,
      before: { archived_at: null },
      after: { archived_at: row.archivedAt },
      requestId: reqId,
    });

    return row;
  });

  if (!archived) return apiError(404, "PAYMENT_METHOD_NOT_FOUND", "No payment method with this ID", reqId);

  return apiSuccess({ id: archived.id, archived_at: archived.archivedAt }, reqId);
}
