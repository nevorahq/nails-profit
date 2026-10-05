import { and, eq } from "drizzle-orm";

import { specialists, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { scopeFor, type MemberRole } from "@/domain/rbac";
import { NO_SPECIALIST } from "@/lib/booking-access";

/**
 * Which clients a caller may open and change.
 *
 * Section 6.1 gives a Master «только назначенные клиенты/визиты», and the list
 * already read it as «clients they have served» — the link is a visit. The card
 * and the endpoints behind it did not: `PATCH /api/v1/clients/[id]` asked
 * only whether the role writes clients, so a Master with an id could rename,
 * archive or — once notes arrived — write about any client of the studio. One
 * function, so the list, the card and every write agree on what «own» means.
 */
export type ClientActor = Readonly<{ userId: string; role: MemberRole }>;

/** The specialist a caller is narrowed to, or null when they see every client. */
export async function scopedClientSpecialistId(
  tx: TenantTransaction,
  actor: ClientActor,
): Promise<string | null> {
  if (scopeFor(actor.role, "clients") !== "own") return null;

  const [own] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(eq(specialists.userId, actor.userId))
    .limit(1);

  return own?.id ?? NO_SPECIALIST;
}

/** Whether this caller may open or change this client. */
export async function mayActOnClient(
  tx: TenantTransaction,
  actor: ClientActor,
  clientId: string,
): Promise<boolean> {
  const own = await scopedClientSpecialistId(tx, actor);
  if (own === null) return true;

  const [served] = await tx
    .select({ id: visits.id })
    .from(visits)
    .where(and(eq(visits.clientId, clientId), eq(visits.specialistId, own)))
    .limit(1);
  return served !== undefined;
}
