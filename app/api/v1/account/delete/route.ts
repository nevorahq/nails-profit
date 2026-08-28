import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/db";
import { memberships, organizations, users } from "@/db/schema";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { auth } from "@/lib/auth";
import { logEvent } from "@/lib/logger";

/**
 * Deleting the account itself, which until now the product could not do at all.
 *
 * «Удалить данные организации» anonymizes a studio and removes its memberships,
 * and it deliberately leaves the person: they may be starting another studio
 * next week. What nobody could do was leave — the row in `user` stayed, so the
 * old password still signed in, the address stayed taken, and somebody trying
 * to start over from registration met «User already exists» on one screen and a
 * working login on the other. Two dead ends and no door.
 *
 * The deletion is a real one: `session`, `account` and `membership` cascade
 * with the row, so every browser holding a session for this person stops
 * working the moment it is gone. Everything that merely *records* them —
 * financial snapshots, audit events, import jobs, the specialist card their
 * studio still needs — references the user with ON DELETE SET NULL, so the
 * studio's books survive the person leaving. That is the whole reason this can
 * be a delete rather than another anonymization.
 *
 * The address is retyped to confirm, exactly as the organization's name is: an
 * irreversible action must not be one stray click.
 */
const deleteSchema = z.object({
  confirmation_email: z.string().trim().min(1).max(320),
});

export async function POST(request: Request) {
  const id = requestId(request);
  /*
   * The session, not `getActiveMembership`. This is the one authenticated
   * action somebody takes when they have no organization at all — which is
   * precisely the state an owner is left in after erasing their studio — and a
   * membership check here would refuse exactly the people it exists for.
   */
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id);
  }

  if (parsed.data.confirmation_email.toLowerCase() !== session.user.email.toLowerCase()) {
    return apiError(422, "CONFIRMATION_MISMATCH", "The confirmation does not match the address", id);
  }

  /*
   * An owner has to erase the studio first.
   *
   * Deleting them here would leave a live organization whose only owner no
   * longer exists: its data would be reachable by nobody, its subscription
   * would carry on, and no remaining member could ever be promoted — the one
   * role that can grant roles would be gone. So this refuses and says which
   * way round the two actions go, rather than producing an orphan.
   */
  const owned = await db
    .select({ id: organizations.id })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, session.user.id),
        eq(memberships.role, "owner"),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  if (owned.length > 0) {
    return apiError(
      409,
      "ORGANIZATION_PRESENT",
      "Delete the organization's data before deleting the account",
      id,
    );
  }

  /*
   * Caught rather than allowed to become a 500.
   *
   * This delete reaches half the schema through cascades and SET NULLs, and the
   * first thing it met in the wild was `financial_snapshot`'s append-only
   * trigger — fixed in migration 0043, but the shape of the failure is worth
   * keeping in mind: a database rule far from here refuses, and what the owner
   * saw was «Не удалось удалить аккаунт» with nothing in it. The refusal now
   * carries a code, and the reason lands in the log with the request id beside
   * it.
   */
  try {
    await db.delete(users).where(eq(users.id, session.user.id));
  } catch (error) {
    logEvent(
      "error",
      "account.delete_failed",
      { requestId: id, userId: session.user.id },
      { reason: error instanceof Error ? error.message : String(error) },
    );
    return apiError(500, "ACCOUNT_DELETE_FAILED", "The account could not be deleted", id);
  }

  // No audit event: `audit_event.organization_id` is not nullable, and this
  // person may belong to no organization at all. The application log is where
  // an account deletion is recorded, without the address.
  logEvent("info", "account.deleted", { requestId: id, userId: session.user.id }, {});

  return apiSuccess({ deleted: true }, id);
}
