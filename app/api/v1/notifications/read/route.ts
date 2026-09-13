import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { bookingModuleRefusal } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { markNoticesRead } from "@/lib/staff-notices";

/**
 * "I have seen the bell."
 *
 * One moment per person per studio, written when they open the list, and that
 * is the whole read model: everything older is read, anything newer is not.
 * No row per notice — the question a bell answers is «есть ли что-то новое»,
 * and a table of read receipts would be a larger thing to keep correct than the
 * question deserves.
 *
 * A POST because it changes something, and the something is small enough that
 * the answer is the moment it wrote: a client that sent the request can stop
 * showing its dot without asking again.
 */
export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  // The same gate the list itself carries: somebody who cannot read the
  // calendar has no notices to have read.
  if (!can(actor.role, "bookings", "read")) {
    return apiError(403, "FORBIDDEN", "This role has no notices", id);
  }
  /*
   * And the same rollout gate, for the same reason the list gives: this is
   * calendar-surface data, and a route on that surface reaches the flag rather
   * than reading around it. A no-op today — `bookingModuleRefusal` refuses
   * writes, and what this writes is the reader's own bookmark.
   */
  const disabled = await bookingModuleRefusal(actor.organizationId, id, "read");
  if (disabled) return disabled;

  const now = new Date();
  await withTenant(actor.organizationId, async (tx) => {
    await markNoticesRead(tx, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      now,
    });
  });

  return apiSuccess({ read_at: now.toISOString() }, id);
}
