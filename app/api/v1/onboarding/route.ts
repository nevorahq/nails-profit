import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { loadOnboarding } from "@/lib/onboarding";

/**
 * The setup checklist, read by the guided setup after it changes something.
 *
 * The dashboard computes the same progress server-side and needs no endpoint;
 * this exists for the other three screens, which have just written a specialist,
 * a service or a visit and have to know whether that finished a step. Deciding
 * it on the client would mean a second implementation of `loadOnboarding` —
 * "a specialist with a rule in force covering a live service" is four conditions
 * and every one of them has already been got wrong once. Asking the same
 * function is the only way the window cannot disagree with the panel it sends
 * people back to.
 *
 * Read-only, and scoped exactly as the panel is: the checklist is catalogue
 * work, and a role that cannot manage the catalogue cannot advance a step.
 */
export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "services")) {
    return apiError(403, "FORBIDDEN", "This role cannot read the setup checklist", id);
  }

  const progress = await withTenant(actor.organizationId, (tx) => loadOnboarding(tx));

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
