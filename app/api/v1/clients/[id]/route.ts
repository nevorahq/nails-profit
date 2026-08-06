import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  bookingAccessTokens,
  bookings,
  clients,
  notificationOutbox,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, scopeFor } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Privacy erasure for one client (roadmap 7.9).
 *
 * The client row is deliberately retained: bookings and visits point to it,
 * and deleting it would either destroy financial history or detach that
 * history from the subject of the erasure. Instead, identifying fields and
 * consent metadata are removed, the row is archived from working lists, live
 * manage links are revoked and notifications still waiting in the queue are
 * dropped.
 *
 * This is an organization-wide privacy operation, so the Master's `own`
 * client scope is not enough. Only roles that may manage every client in the
 * organization can perform it.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(
      404,
      "MEMBERSHIP_NOT_FOUND",
      "User does not belong to an organization",
      requestIdentifier,
    );
  }

  const actor = caller.membership;
  if (!can(actor.role, "clients", "write") || scopeFor(actor.role, "clients") !== "all") {
    return apiError(403, "FORBIDDEN", "This role cannot erase clients", requestIdentifier);
  }

  const { id: clientId } = await context.params;
  if (!z.uuid().safeParse(clientId).success) {
    return apiError(404, "CLIENT_NOT_FOUND", "No client with this ID", requestIdentifier);
  }

  const now = new Date();
  const outcome = await withTenant(actor.organizationId, async (tx) => {
    // The lock serializes two erasure requests. It also keeps the audit event
    // single: a retry returns the already-anonymized result without appending a
    // second event that pretends another privacy operation happened.
    const [existing] = await tx
      .select({ id: clients.id, anonymizedAt: clients.anonymizedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1)
      .for("update");

    if (!existing) return null;
    if (existing.anonymizedAt) {
      return { id: existing.id, anonymizedAt: existing.anonymizedAt, alreadyAnonymized: true };
    }

    const clientBookings = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.clientId, existing.id));
    const bookingIds = clientBookings.map((booking) => booking.id);

    let tokensRevoked = 0;
    let notificationsDropped = 0;
    if (bookingIds.length > 0) {
      tokensRevoked = (
        await tx
          .update(bookingAccessTokens)
          .set({ revokedAt: now })
          .where(
            and(
              inArray(bookingAccessTokens.bookingId, bookingIds),
              isNull(bookingAccessTokens.revokedAt),
            ),
          )
          .returning({ id: bookingAccessTokens.id })
      ).length;

      notificationsDropped = (
        await tx
          .delete(notificationOutbox)
          .where(
            and(
              inArray(notificationOutbox.bookingId, bookingIds),
              inArray(notificationOutbox.status, ["pending", "retry"]),
            ),
          )
          .returning({ id: notificationOutbox.id })
      ).length;
    }

    const [anonymized] = await tx
      .update(clients)
      .set({
        name: "Deleted client",
        normalizedPhone: null,
        email: null,
        locale: null,
        termsVersion: null,
        privacyVersion: null,
        consentedAt: null,
        anonymizedAt: now,
        archivedAt: now,
        updatedBy: actor.userId,
        updatedAt: now,
        version: sql`${clients.version} + 1`,
      })
      .where(and(eq(clients.id, existing.id), isNull(clients.anonymizedAt)))
      .returning({ id: clients.id, anonymizedAt: clients.anonymizedAt });

    if (!anonymized) return null;

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "client.anonymized",
      entityType: "client",
      entityId: anonymized.id,
      // Counts describe the privacy operation without copying the erased PII.
      after: {
        bookings_preserved: bookingIds.length,
        access_tokens_revoked: tokensRevoked,
        notifications_dropped: notificationsDropped,
      },
      requestId: requestIdentifier,
    });

    return { id: anonymized.id, anonymizedAt: anonymized.anonymizedAt, alreadyAnonymized: false };
  });

  // RLS makes an ID from another tenant indistinguishable from an unknown ID.
  if (!outcome) {
    return apiError(404, "CLIENT_NOT_FOUND", "No client with this ID", requestIdentifier);
  }

  return apiSuccess(
    {
      id: outcome.id,
      anonymized: true,
      anonymized_at: outcome.anonymizedAt,
      already_anonymized: outcome.alreadyAnonymized,
    },
    requestIdentifier,
  );
}
