import { eq } from "drizzle-orm";

import { specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { scopeFor, type MemberRole } from "@/domain/rbac";

/**
 * Which calendar a caller is allowed to see and change.
 *
 * Section 6.1 gives a Master the `bookings` capability at scope "own" — «свои
 * записи». Every booking endpoint has to narrow to that, and the narrowing has
 * to come from the specialist row carrying the caller's account rather than
 * from a parameter the caller supplies. This was written out separately in each
 * handler until there were six of them; one function is one place to be right.
 */
export type CalendarActor = Readonly<{ userId: string; role: MemberRole }>;

/**
 * A Master with no specialist row of their own. Filtering on it matches nothing,
 * which is the correct answer: an account not linked to a specialist owns no
 * appointments. Returning null instead would read as "sees everything".
 */
export const NO_SPECIALIST = "00000000-0000-0000-0000-000000000000";

/** The specialist to filter on, or null when the role sees the whole studio. */
export async function scopedSpecialistId(
  tx: TenantTransaction,
  actor: CalendarActor,
): Promise<string | null> {
  if (scopeFor(actor.role, "bookings") !== "own") return null;

  const [own] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(eq(specialists.userId, actor.userId))
    .limit(1);

  return own?.id ?? NO_SPECIALIST;
}

/** Whether this caller may read or change appointments of that specialist. */
export async function mayActOnSpecialist(
  tx: TenantTransaction,
  actor: CalendarActor,
  specialistId: string,
): Promise<boolean> {
  const scoped = await scopedSpecialistId(tx, actor);
  return scoped === null || scoped === specialistId;
}
