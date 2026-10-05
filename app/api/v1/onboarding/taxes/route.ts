import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { RULE_CHANGE_REFUSALS } from "@/domain/rule-change";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { answerTaxes } from "@/lib/money-answers";

/**
 * «Как вы платите налоги?» — the month guide's step, answered once.
 *
 * «Не плачу с визита» writes no rule and is still an answer; a rate writes the
 * same rule `POST /api/v1/tax-rules` does. The rate has no default on either
 * side: what a studio owes is the owner's to say, and a pre-filled 20% would be
 * a tax the product invented and the report then subtracted.
 *
 * Owner alone, through `expenses` — the capability every tax rule is written
 * under.
 */
const answerShape = z.discriminatedUnion("answer", [
  z.object({ answer: z.literal("none") }),
  z.object({
    answer: z.enum(["turnover", "vat"]),
    /** 2000 = 20%. */
    basis_points: z.int().min(0).max(10_000),
  }),
]);

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "expenses", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot answer for the studio's taxes", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = answerShape.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const data = parsed.data;
  const result = await withTenant(actor.organizationId, (tx) =>
    answerTaxes(
      tx,
      actor,
      data.answer === "none" ? { answer: "none" } : { answer: data.answer, basisPoints: data.basis_points },
      id,
    ),
  );

  if (!result.ok) {
    if (result.reason === "already_answered") {
      return apiError(409, "ALREADY_ANSWERED", "The studio has already answered for its taxes", id);
    }
    const refusal = RULE_CHANGE_REFUSALS[result.reason];
    return apiError(422, refusal.code, refusal.message, id);
  }

  return apiSuccess({ answer: data.answer }, id, 201);
}
