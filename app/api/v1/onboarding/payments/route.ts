import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { answerPayments } from "@/lib/money-answers";

/**
 * «Как платят клиенты?» — the month guide's step, answered once, as payment
 * methods.
 *
 * The bank's rate is required with card and refused without it, and never
 * filled in for the owner: it is a term of their contract, not a market figure.
 * The default is the method the owner says is most frequent, and a single
 * method is its own default.
 *
 * Owner alone, through `expenses`, like the rest of «Деньги».
 */
const kinds = ["cash", "card", "transfer"] as const;

const answerShape = z
  .object({
    methods: z
      .array(z.enum(kinds))
      .min(1)
      .refine((methods) => new Set(methods).size === methods.length, { message: "Each method once" }),
    /** 220 = 2.2% taken by the acquirer. */
    card_commission_basis_points: z.int().min(0).max(10_000).optional(),
    default: z.enum(kinds).optional(),
  })
  .superRefine((value, context) => {
    const card = value.methods.includes("card");
    if (card && value.card_commission_basis_points === undefined) {
      context.addIssue({ code: "custom", path: ["card_commission_basis_points"], message: "Required with card" });
    }
    if (!card && value.card_commission_basis_points !== undefined) {
      context.addIssue({ code: "custom", path: ["card_commission_basis_points"], message: "Only with card" });
    }
    if (value.default === undefined ? value.methods.length > 1 : !value.methods.includes(value.default)) {
      context.addIssue({ code: "custom", path: ["default"], message: "One of the chosen methods" });
    }
  });

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "expenses", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot answer for the studio's payments", id);
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
    answerPayments(
      tx,
      actor,
      {
        methods: data.methods,
        cardBasisPoints: data.card_commission_basis_points ?? null,
        defaultKind: data.default ?? data.methods[0],
      },
      id,
    ),
  );

  if (!result.ok) {
    return apiError(409, "ALREADY_ANSWERED", "The studio has already answered for its payments", id);
  }

  return apiSuccess({ methods: data.methods, default: data.default ?? data.methods[0] }, id, 201);
}
