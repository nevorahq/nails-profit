import { asc } from "drizzle-orm";
import { z } from "zod";

import { taxRules } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { RULE_CHANGE_REFUSALS } from "@/domain/rule-change";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { createTaxRule } from "@/lib/tax-rules";

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
  /**
   * The studio's day the new rate takes over from, `YYYY-MM-DD`; absent is
   * now. Today or later — see `domain/rule-change.ts`.
   */
  effective_date: z.iso.date().optional(),
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

  const created = await withTenant(actor.organizationId, (tx) =>
    createTaxRule(
      tx,
      actor,
      {
        kind: data.kind,
        basisPoints: data.basis_points,
        remittable: data.remittable,
        effectiveDate: data.effective_date,
      },
      id,
    ),
  );

  if (!created.ok) {
    const refusal = RULE_CHANGE_REFUSALS[created.reason];
    return apiError(422, refusal.code, refusal.message, id, {
      fieldErrors: [{ field: "effective_date", code: created.reason, message: refusal.message }],
    });
  }

  return apiSuccess(
    {
      id: created.row.id,
      kind: created.row.kind,
      basis_points: created.row.basisPoints,
      remittable: created.row.remittable,
      active_from: created.row.activeFrom,
      active_to: created.row.activeTo,
    },
    id,
    201,
  );
}
