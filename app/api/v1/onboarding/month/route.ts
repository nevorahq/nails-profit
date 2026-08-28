import { eq } from "drizzle-orm";

import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { loadMonthSetup } from "@/lib/onboarding";
import { monthOf } from "@/lib/period";

/**
 * The month's checklist, read by the guided setup after it writes an expense or
 * a rota — the sibling of `/api/v1/onboarding`, and for the same reason: the
 * screens that finish a step must not decide for themselves that they have.
 *
 * "This month" is resolved here rather than taken from the caller. The steps
 * mean what the dashboard's panel means by them, and a client free to name a
 * month could congratulate a studio for a January it is not looking at.
 *
 * Owner alone, like the panel: `expenses` is an owner-only capability, so for
 * anybody else both steps are doors that do not open.
 */
export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "expenses", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read the month's checklist", id);
  }

  const progress = await withTenant(actor.organizationId, async (tx) => {
    // The organization's own currency: the ledger is read in one currency, and
    // rows in another are not this month's overhead — see `loadMonthSetup`.
    const [organization] = await tx
      .select({ currency: organizations.currency })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);

    return loadMonthSetup(tx, {
      month: monthOf(new Date()),
      currency: organization?.currency ?? "MDL",
    });
  });

  return apiSuccess(
    {
      done: progress.done,
      total: progress.total,
      complete: progress.complete,
      next: progress.next?.key ?? null,
      steps: progress.steps.map((step) => ({ key: step.key, done: step.done, href: step.href })),
    },
    id,
  );
}
