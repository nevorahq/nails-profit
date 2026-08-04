import { auditEvents } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";

/**
 * Spec section 15.3 requires an audit log for role changes, policies,
 * commissions, financial adjustments, consent and exports. Invitations are the
 * first writer: issuing, accepting or revoking one changes who holds which role.
 *
 * Writes go through the tenant transaction so the row lands under the same RLS
 * policy as the change it records, and so an audit entry cannot survive a rolled
 * back mutation.
 */
export type AuditEventInput = Readonly<{
  organizationId: string;
  actorUserId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  requestId: string;
}>;

export async function recordAuditEvent(tx: TenantTransaction, event: AuditEventInput) {
  await tx.insert(auditEvents).values({
    organizationId: event.organizationId,
    actorUserId: event.actorUserId,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    before: event.before ?? null,
    after: event.after ?? null,
    requestId: event.requestId,
  });
}
