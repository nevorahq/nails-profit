import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { bookingModuleRefusal } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { markNoticeRead } from "@/lib/staff-notices";

/**
 * "I have dealt with this one."
 *
 * It used to be «I have seen the bell» — one moment per person per studio,
 * written when they opened the list, and everything older than it was read.
 * That answers «есть ли что-то новое» and it was the right shape while the feed
 * was a record of what happened.
 *
 * It is a queue now: a line sinks below the ones still waiting once its
 * appointment has been opened, and a list that emptied itself the moment
 * somebody glanced at it could not also be the list of what is left to work
 * through. One timestamp cannot say «эти три я посмотрел, а ту нет» however it
 * is read, so the mark is per appointment — see `staff_notice_read`.
 *
 * The booking is not checked against what this reader can see. Nothing is
 * revealed by writing one of these: the row is never read back by anybody else,
 * the foreign key already refuses an appointment that does not exist, and the
 * tenant policy refuses one belonging to another studio. What is left is
 * somebody marking their own copy of a line they were not shown, which costs
 * nothing and saves a query on every click.
 */
const schema = z.object({ booking_id: z.uuid() });

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

  /*
   * Parsed after the role is checked, so somebody without the calendar still
   * meets a 403 rather than a complaint about their request body: which of the
   * two a caller is told is the difference the RBAC matrix asserts.
   */
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const now = new Date();
  await withTenant(actor.organizationId, async (tx) => {
    await markNoticeRead(tx, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      bookingId: parsed.data.booking_id,
      now,
    });
  });

  return apiSuccess({ booking_id: parsed.data.booking_id, read_at: now.toISOString() }, id);
}
