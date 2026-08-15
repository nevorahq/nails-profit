import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { paymentMethods } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * How the studio takes money, and what the acquirer charges for it.
 *
 * Read by anyone who may record a visit — the list is a field on the closing
 * form, and a master who cannot see it cannot say the client paid by card.
 * Written by the owner alone: the rate is a term of a contract with a bank, and
 * it reaches the margin of every visit taken on it.
 *
 * Not versioned. The rate is copied into each visit at closing time, so a new
 * contract is a plain edit here and every closed visit keeps what it was
 * charged at — versioning exists for rules resolved for a *past* date, and this
 * one never is.
 */
const methodShape = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["cash", "card", "transfer", "other"]),
  /** 220 = 2.2% taken by the acquirer. Zero for cash, which is the point. */
  commission_basis_points: z.int().min(0).max(10_000).optional(),
  fixed_fee_minor: z.int().min(0).optional(),
  is_default: z.boolean().optional(),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "bookings", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read payment methods", id);
  }

  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx
      .select({
        id: paymentMethods.id,
        name: paymentMethods.name,
        kind: paymentMethods.kind,
        commission_basis_points: paymentMethods.commissionBasisPoints,
        fixed_fee_minor: paymentMethods.fixedFeeMinor,
        is_default: paymentMethods.isDefault,
      })
      .from(paymentMethods)
      .where(isNull(paymentMethods.archivedAt))
      .orderBy(asc(paymentMethods.createdAt)),
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
  // The rate is a financial setting, so it takes the capability financial
  // settings take — the same one that guards currency and the reserve.
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage payment methods", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = methodShape.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const data = parsed.data;

  const created = await withTenant(actor.organizationId, async (tx) => {
    // One default at a time, cleared here rather than left to the unique index
    // to refuse: naming a new default is a normal thing to do, not an error.
    if (data.is_default) {
      await tx
        .update(paymentMethods)
        .set({ isDefault: false, updatedBy: actor.userId, updatedAt: new Date() })
        .where(and(eq(paymentMethods.isDefault, true), isNull(paymentMethods.archivedAt)));
    }

    const [row] = await tx
      .insert(paymentMethods)
      .values({
        organizationId: actor.organizationId,
        name: data.name,
        kind: data.kind,
        commissionBasisPoints: data.commission_basis_points ?? 0,
        fixedFeeMinor: data.fixed_fee_minor ?? 0,
        isDefault: data.is_default ?? false,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "payment_method.created",
      entityType: "payment_method",
      entityId: row.id,
      after: {
        name: row.name,
        kind: row.kind,
        commission_basis_points: row.commissionBasisPoints,
        fixed_fee_minor: row.fixedFeeMinor,
        is_default: row.isDefault,
      },
      requestId: id,
    });

    return row;
  });

  return apiSuccess(
    {
      id: created.id,
      name: created.name,
      kind: created.kind,
      commission_basis_points: created.commissionBasisPoints,
      fixed_fee_minor: created.fixedFeeMinor,
      is_default: created.isDefault,
    },
    id,
    201,
  );
}
