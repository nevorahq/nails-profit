import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  addOns,
  auditEvents,
  clients,
  commissionRuleServices,
  commissionRules,
  expenses,
  externalReferences,
  financialSnapshots,
  importJobs,
  invitations,
  chairRents,
  laborCostRules,
  masterPayouts,
  materialsCostingPeriods,
  memberships,
  organizations,
  ownerDraws,
  paymentMethods,
  pilotEnrollments,
  pilotInteractions,
  pilotIssues,
  pilotProductEvents,
  serviceAddOns,
  serviceCategories,
  services,
  specialists,
  taxRules,
  users,
  visitLines,
  visitPhotos,
  visits,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { effectiveInvitationStatus } from "@/domain/invitation";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { getPhotoStorage } from "@/lib/photo-storage";
import { photoUrl } from "@/lib/visit-photos";

/**
 * 7: the chairs' rent (`chair_rents`) and the payouts to masters
 * (`master_payouts`). Added, not moved.
 *
 * 6: photos of work, each with a link that opens it for 24 hours. The bytes
 * are not in the file — a studio's gigabyte does not fit in one response — so
 * the owner downloads them from the links while they last.
 *
 * 5: a client carries the studio's note about them (`client.notes`). Added,
 * not moved: a consumer written for 4 reads every field it knew.
 *
 * 4: materials, their price versions, recipes, recipe items and consumptions
 * left the payload with the material engine itself. The first bump that takes
 * something away rather than adding it, so a consumer written for 3 will find
 * five keys missing — which is exactly what the version is for.
 *
 * 3: the labour rules joined the payload.
 *
 * 2: the expense ledger joined the payload. A consumer written for version 1
 * still reads every field it knew, so the bump is a signal that more arrived,
 * not that anything moved.
 */
export const EXPORT_FORMAT_VERSION = 7;

/** How long the photo links in an export open: a day to download them. */
const EXPORT_LINK_SECONDS = 24 * 60 * 60;

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
    const commissionRuleServiceRows = await tx
      .select()
      .from(commissionRuleServices)
      .orderBy(asc(commissionRuleServices.createdAt));
    const clientRows = await tx.select().from(clients).orderBy(asc(clients.createdAt));
    const visitRows = await tx.select().from(visits).orderBy(asc(visits.createdAt));
    const visitLineRows = await tx.select().from(visitLines).orderBy(asc(visitLines.createdAt));
    const visitPhotoRows = await tx
      .select({
        id: visitPhotos.id,
        visitId: visitPhotos.visitId,
        storagePath: visitPhotos.storagePath,
        mimeType: visitPhotos.mimeType,
        sizeBytes: visitPhotos.sizeBytes,
        width: visitPhotos.width,
        height: visitPhotos.height,
        createdAt: visitPhotos.createdAt,
      })
      .from(visitPhotos)
      .orderBy(asc(visitPhotos.createdAt));
    const financialSnapshotRows = await tx
      .select()
      .from(financialSnapshots)
      .orderBy(asc(financialSnapshots.createdAt));
    const externalReferenceRows = await tx
      .select()
      .from(externalReferences)
      .orderBy(asc(externalReferences.createdAt));
    const laborCostRows = await tx
      .select()
      .from(laborCostRules)
      .orderBy(asc(laborCostRules.activeFrom));
    const chairRentRows = await tx.select().from(chairRents).orderBy(asc(chairRents.activeFrom));
    // A note on a payout is free text the owner typed, so it can name anybody;
    // it travels with the rest of the studio's own words.
    const masterPayoutRows = await tx
      .select()
      .from(masterPayouts)
      .orderBy(asc(masterPayouts.paidOn), asc(masterPayouts.createdAt));
    const paymentMethodRows = await tx
      .select()
      .from(paymentMethods)
      .orderBy(asc(paymentMethods.createdAt));
    const taxRuleRows = await tx.select().from(taxRules).orderBy(asc(taxRules.activeFrom));
    const materialsPeriodRows = await tx
      .select()
      .from(materialsCostingPeriods)
      .orderBy(asc(materialsCostingPeriods.effectiveFrom));
    const expenseRows = await tx.select().from(expenses).orderBy(asc(expenses.spentOn), asc(expenses.createdAt));
    const ownerDrawRows = await tx
      .select()
      .from(ownerDraws)
      .orderBy(asc(ownerDraws.occurredOn), asc(ownerDraws.createdAt));
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
        services: serviceRows.length,
        clients: clientRows.length,
        visits: visitRows.length,
        visit_photos: visitPhotoRows.length,
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
      service_categories: serviceCategoryRows,
      services: serviceRows,
      add_ons: addOnRows,
      service_add_ons: serviceAddOnRows,
      specialists: specialistRows,
      commission_rules: commissionRuleRows,
      commission_rule_services: commissionRuleServiceRows,
      clients: clientRows,
      visits: visitRows,
      visit_lines: visitLineRows,
      visit_photos: visitPhotoRows,
      financial_snapshots: financialSnapshotRows,
      expenses: expenseRows,
      labor_cost_rules: laborCostRows,
      owner_draws: ownerDrawRows,
      chair_rents: chairRentRows,
      master_payouts: masterPayoutRows,
      payment_methods: paymentMethodRows,
      tax_rules: taxRuleRows,
      materials_costing_periods: materialsPeriodRows,
      external_references: externalReferenceRows,
      import_jobs: importJobRows,
      pilot_enrollment: pilotEnrollmentRows,
      pilot_product_events: pilotEventRows,
      pilot_interactions: pilotInteractionRows,
      pilot_issues: pilotIssueRows,
      audit_events: auditRows,
    };
  });

  /*
   * Signed after the transaction, which should not wait on Storage. A deployment
   * without the bucket — or a driver that serves bytes itself — links to the
   * application's own address instead, which needs the owner's session.
   */
  const storage = getPhotoStorage();
  const signed = storage
    ? await storage
        .signedUrls(payload.visit_photos.map((photo) => photo.storagePath), EXPORT_LINK_SECONDS)
        .catch(() => new Map<string, string>())
    : new Map<string, string>();
  const exported = {
    ...payload,
    visit_photos: payload.visit_photos.map(({ storagePath, ...photo }) => ({
      ...photo,
      url: signed.get(storagePath) ?? photoUrl(photo.visitId, photo.id),
      url_expires_at: signed.has(storagePath)
        ? new Date(Date.now() + EXPORT_LINK_SECONDS * 1000).toISOString()
        : null,
    })),
  };

  const filename = `nail-profit-export-${actor.organizationId}.json`;
  return NextResponse.json(
    { data: exported, request_id: id },
    {
      headers: {
        "x-request-id": id,
        "content-disposition": `attachment; filename="${filename}"`,
      },
    },
  );
}
