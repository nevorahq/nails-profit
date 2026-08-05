import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  auditEvents,
  clients,
  externalReferences,
  importJobs,
  invitations,
  memberships,
  organizations,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Owner-requested erasure, spec section 4.3, run as the administrative workflow
 * section 15.3 asks for: the caller must retype the organization name, so an
 * irreversible action cannot be triggered by a stray click or a replayed
 * request.
 *
 * What it does NOT do is drop rows. Section 15.3 says deletion anonymizes PII
 * while required financial records are kept, and the financial tables reference
 * the organization with ON DELETE RESTRICT for exactly that reason. So the
 * organization and its PII-bearing tenant rows are anonymized, every membership
 * is removed and every pending invitation is revoked — an invitation is a live
 * credential and would otherwise outlive the organization it grants access to.
 */
const deleteSchema = z.object({
  confirmation_name: z.string().trim().min(1).max(100),
});

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "data_export", "write")) {
    return apiError(403, "FORBIDDEN", "Only an owner can delete organization data", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id);
  }

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id, name: organizations.name, deletedAt: organizations.deletedAt })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);

    if (!organization || organization.deletedAt) return { failure: "ALREADY_DELETED" as const };
    if (organization.name.trim() !== parsed.data.confirmation_name) {
      return { failure: "CONFIRMATION_MISMATCH" as const };
    }

    const revoked = await tx
      .update(invitations)
      .set({
        status: "revoked",
        email: sql`concat('deleted-', ${invitations.id}::text, '@invalid.local')`,
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${invitations.version} + 1`,
      })
      .where(eq(invitations.organizationId, actor.organizationId))
      .returning({ id: invitations.id });

    const anonymizedClients = await tx
      .update(clients)
      .set({
        name: sql`concat('Deleted client ', left(${clients.id}::text, 8))`,
        normalizedPhone: null,
        email: null,
        locale: null,
        anonymizedAt: new Date(),
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${clients.version} + 1`,
      })
      .where(eq(clients.organizationId, actor.organizationId))
      .returning({ id: clients.id });

    const anonymizedSpecialists = await tx
      .update(specialists)
      .set({
        name: sql`concat('Deleted specialist ', left(${specialists.id}::text, 8))`,
        userId: null,
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${specialists.version} + 1`,
      })
      .where(eq(specialists.organizationId, actor.organizationId))
      .returning({ id: specialists.id });

    await tx
      .update(importJobs)
      .set({ fileName: "deleted-import.csv", sourceText: null, issues: [] })
      .where(eq(importJobs.organizationId, actor.organizationId));

    // Provider identifiers are synchronization metadata, not financial history,
    // and can contain a source-system contact or natural key.
    await tx
      .delete(externalReferences)
      .where(eq(externalReferences.organizationId, actor.organizationId));

    // Older invitation/specialist events can contain names or email addresses.
    // Keep the immutable event identity and timestamp, but remove free-form
    // payloads before appending the PII-free deletion event below.
    await tx
      .update(auditEvents)
      .set({ before: { redacted: true }, after: { redacted: true } })
      .where(eq(auditEvents.organizationId, actor.organizationId));

    const removed = await tx
      .delete(memberships)
      .where(eq(memberships.organizationId, actor.organizationId))
      .returning({ id: memberships.id });

    // The audit event records counts, not the former name. Writing the name back
    // into the log would undo the anonymization one line above it; section 15.3
    // keeps audit for 24 months.
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "organization.deleted",
      entityType: "organization",
      entityId: actor.organizationId,
      after: {
        memberships_removed: removed.length,
        invitations_revoked: revoked.length,
        clients_anonymized: anonymizedClients.length,
        specialists_anonymized: anonymizedSpecialists.length,
      },
      requestId: id,
    });

    await tx
      .update(organizations)
      .set({
        name: `Удалённая организация ${actor.organizationId.slice(0, 8)}`,
        deletedAt: new Date(),
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${organizations.version} + 1`,
      })
      .where(and(eq(organizations.id, actor.organizationId), isNull(organizations.deletedAt)));

    return {
      memberships_removed: removed.length,
      invitations_revoked: revoked.length,
      clients_anonymized: anonymizedClients.length,
      specialists_anonymized: anonymizedSpecialists.length,
    };
  });

  if ("failure" in outcome) {
    return outcome.failure === "ALREADY_DELETED"
      ? apiError(409, "ORGANIZATION_DELETED", "The organization is already deleted", id)
      : apiError(422, "CONFIRMATION_MISMATCH", "The confirmation does not match the organization name", id);
  }

  return apiSuccess(outcome, id);
}
