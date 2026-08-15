import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { taxRules } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Taxes that attach to a visit: VAT, turnover tax, contributions on commission.
 *
 * Owner-only through `expenses`, reading included — what a business owes the
 * state is the same kind of fact as what it pays in rent.
 *
 * Versioned like `labor_cost_rule`: a rate that changes in July has to leave
 * June reporting June's, so a new rate is a new row that closes the old one at
 * the same instant. There is deliberately no PATCH.
 *
 * A fixed monthly contribution is not here on purpose. The expense ledger
 * already records it as a recurring row in the `taxes` category, and two ways
 * to enter the same money is how a sum gets subtracted twice.
 */
const ruleShape = z.object({
  kind: z.enum(["vat", "turnover", "payroll"]),
  /** 2000 = 20%. */
  basis_points: z.int().min(0).max(10_000),
  /**
   * Only meaningful for VAT: false records the rate without taking it out of
   * revenue, for a business that shows VAT on a document but does not remit it.
   */
  remittable: z.boolean().optional(),
  active_from: z.iso.datetime().optional(),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "expenses", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read tax rules", id);
  }

  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx
      .select({
        id: taxRules.id,
        kind: taxRules.kind,
        basis_points: taxRules.basisPoints,
        remittable: taxRules.remittable,
        active_from: taxRules.activeFrom,
        active_to: taxRules.activeTo,
      })
      .from(taxRules)
      .orderBy(asc(taxRules.activeFrom), asc(taxRules.createdAt)),
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
    return apiError(403, "FORBIDDEN", "This role cannot manage tax rules", id);
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
    /*
     * A new rate closes the old one at the same instant.
     *
     * Two live rules of one kind would be a data error `selectTaxRates` has to
     * guess its way out of, and the guess it makes — take the newer — is a
     * fallback rather than a design. Closing here is the design.
     */
    await tx
      .update(taxRules)
      .set({ activeTo: activeFrom, updatedBy: actor.userId, updatedAt: new Date() })
      .where(and(eq(taxRules.kind, data.kind), isNull(taxRules.activeTo)));

    const [row] = await tx
      .insert(taxRules)
      .values({
        organizationId: actor.organizationId,
        kind: data.kind,
        basisPoints: data.basis_points,
        remittable: data.remittable ?? true,
        activeFrom,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "tax_rule.created",
      entityType: "tax_rule",
      entityId: row.id,
      after: {
        kind: row.kind,
        basis_points: row.basisPoints,
        remittable: row.remittable,
        active_from: row.activeFrom,
      },
      requestId: id,
    });

    return row;
  });

  return apiSuccess(
    {
      id: created.id,
      kind: created.kind,
      basis_points: created.basisPoints,
      remittable: created.remittable,
      active_from: created.activeFrom,
      active_to: created.activeTo,
    },
    id,
    201,
  );
}
