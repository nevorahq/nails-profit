import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  addOns,
  auditEvents,
  clients,
  commissionRules,
  consumptions,
  externalReferences,
  financialSnapshots,
  importJobs,
  invitations,
  materialPriceVersions,
  materials,
  memberships,
  organizations,
  pilotEnrollments,
  pilotInteractions,
  pilotIssues,
  pilotProductEvents,
  recipeItems,
  recipes,
  serviceAddOns,
  serviceCategories,
  services,
  specialists,
  users,
  visitLines,
  visits,
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

    const members = await tx
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
    const serviceCategoryRows = await tx
      .select()
      .from(serviceCategories)
      .orderBy(asc(serviceCategories.createdAt));
    const addOnRows = await tx.select().from(addOns).orderBy(asc(addOns.createdAt));
    const serviceAddOnRows = await tx
      .select()
      .from(serviceAddOns)
      .orderBy(asc(serviceAddOns.createdAt));
    const specialistRows = await tx.select().from(specialists).orderBy(asc(specialists.createdAt));
    const commissionRuleRows = await tx
      .select()
      .from(commissionRules)
      .orderBy(asc(commissionRules.createdAt));
    const recipeRows = await tx.select().from(recipes).orderBy(asc(recipes.createdAt));
    const recipeItemRows = await tx.select().from(recipeItems).orderBy(asc(recipeItems.createdAt));
    const clientRows = await tx.select().from(clients).orderBy(asc(clients.createdAt));
    const visitRows = await tx.select().from(visits).orderBy(asc(visits.createdAt));
    const visitLineRows = await tx.select().from(visitLines).orderBy(asc(visitLines.createdAt));
    const consumptionRows = await tx.select().from(consumptions).orderBy(asc(consumptions.createdAt));
    const financialSnapshotRows = await tx
      .select()
      .from(financialSnapshots)
      .orderBy(asc(financialSnapshots.createdAt));
    const externalReferenceRows = await tx
      .select()
      .from(externalReferences)
      .orderBy(asc(externalReferences.createdAt));
    const importJobRows = await tx.select().from(importJobs).orderBy(asc(importJobs.createdAt));
    const pilotEnrollmentRows = await tx.select().from(pilotEnrollments);
    const pilotEventRows = await tx
      .select()
      .from(pilotProductEvents)
      .orderBy(asc(pilotProductEvents.occurredAt));
    const pilotInteractionRows = await tx
      .select()
      .from(pilotInteractions)
      .orderBy(asc(pilotInteractions.occurredAt));
    const pilotIssueRows = await tx.select().from(pilotIssues).orderBy(asc(pilotIssues.detectedAt));
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
        clients: clientRows.length,
        visits: visitRows.length,
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
      service_categories: serviceCategoryRows,
      services: serviceRows,
      add_ons: addOnRows,
      service_add_ons: serviceAddOnRows,
      specialists: specialistRows,
      commission_rules: commissionRuleRows,
      recipes: recipeRows,
      recipe_items: recipeItemRows,
      clients: clientRows,
      visits: visitRows,
      visit_lines: visitLineRows,
      consumptions: consumptionRows,
      financial_snapshots: financialSnapshotRows,
      external_references: externalReferenceRows,
      import_jobs: importJobRows,
      pilot_enrollment: pilotEnrollmentRows,
      pilot_product_events: pilotEventRows,
      pilot_interactions: pilotInteractionRows,
      pilot_issues: pilotIssueRows,
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
