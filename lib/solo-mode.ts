import { and, eq, sql } from "drizzle-orm";

import { organizations } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";

/**
 * The moment a studio of one stops being one.
 *
 * `organization.type` used to be a control in «Настройки» that an owner had to
 * hold an opinion about. It is not there any more, and the reason it could go
 * is here: the two events that make «оплата труда мастеров» true are events
 * the product already sees. A second master appears in the catalogue, or
 * somebody accepts an invitation and signs in. Nobody has to notice and go
 * looking for a dropdown.
 *
 * Written once rather than as a condition at each call site, for the reason
 * `domain/principal.ts` gives about the principal mark: two screens asking the
 * same question must not be able to disagree about the answer.
 *
 * One direction only. Growing out of solo is an observable fact; shrinking back
 * into it is not — a studio whose second master leaves in March is still a
 * studio in the March report, and guessing otherwise would rewrite the wording
 * of a month that has already been read. Going back is
 * `PATCH /api/v1/organizations/settings`, which still takes the type.
 *
 * Idempotent and safe to call when the answer is already «studio»: the guard
 * is in the `where`, so a second call updates nothing and records nothing.
 */
export async function leaveSoloMode(
  tx: TenantTransaction,
  input: Readonly<{
    organizationId: string;
    actorUserId: string;
    requestId: string;
    /** What was observed — a row in the audit log nobody can reconstruct later. */
    because: "second_specialist" | "invitation_accepted";
  }>,
): Promise<boolean> {
  const promoted = await tx
    .update(organizations)
    .set({
      type: "studio",
      updatedBy: input.actorUserId,
      updatedAt: new Date(),
      version: sql`${organizations.version} + 1`,
    })
    .where(and(eq(organizations.id, input.organizationId), eq(organizations.type, "solo")))
    .returning({ id: organizations.id });

  if (promoted.length === 0) return false;

  await recordAuditEvent(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    eventType: "organization.settings_changed",
    entityType: "organization",
    entityId: input.organizationId,
    before: { type: "solo" },
    after: { type: "studio", reason: input.because },
    requestId: input.requestId,
  });

  return true;
}
