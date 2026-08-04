import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import {
  auditEvents,
  invitations,
  materialPriceVersions,
  materials,
  memberships,
  organizations,
  services,
  users,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { effectiveInvitationStatus } from "@/domain/invitation";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

export const EXPORT_FORMAT_VERSION = 1;

/**
 * Owner-requested export of everything the organization owns, spec section 4.3.
 * Section 6.1 restricts this to the Owner: a Manager cannot export, and hiding
 * the button would not be a control, so the capability is checked here.
 *
 * Section 15.3 requires exports to be audited, so the export writes an audit
 * event in the same transaction that reads the data.
 */
export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "data_export", "read")) {
    return apiError(403, "FORBIDDEN", "Only an owner can export organization data", id);
  }

  const payload = await withTenant(actor.organizationId, async (tx) => {
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);

    const members = await db
      .select({
        email: users.email,
        name: users.name,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.organizationId, actor.organizationId))
      .orderBy(asc(memberships.createdAt));

    const invitationRows = await tx
      .select({
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .orderBy(asc(invitations.createdAt));

    const materialRows = await tx.select().from(materials).orderBy(asc(materials.createdAt));
    const priceRows = await tx
      .select()
      .from(materialPriceVersions)
      .orderBy(asc(materialPriceVersions.validFrom));
    const serviceRows = await tx.select().from(services).orderBy(asc(services.createdAt));
    const auditRows = await tx.select().from(auditEvents).orderBy(asc(auditEvents.createdAt));

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "organization.exported",
      entityType: "organization",
      entityId: actor.organizationId,
      after: {
        members: members.length,
        materials: materialRows.length,
        services: serviceRows.length,
      },
      requestId: id,
    });

    return {
      format_version: EXPORT_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      organization,
      members,
      // Invitation token hashes are deliberately absent: they authenticate the
      // accept endpoint and belong in no file that leaves the server.
      invitations: invitationRows.map((row) => ({
        ...row,
        status: effectiveInvitationStatus(row.status, row.expiresAt),
      })),
      materials: materialRows,
      material_price_versions: priceRows,
      services: serviceRows,
      audit_events: auditRows,
    };
  });

  const filename = `nail-profit-export-${actor.organizationId}.json`;
  return NextResponse.json(
    { data: payload, request_id: id },
    {
      headers: {
        "x-request-id": id,
        "content-disposition": `attachment; filename="${filename}"`,
      },
    },
  );
}
