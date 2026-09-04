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
import { isUniqueViolation } from "@/lib/db-errors";
import { normalizePhone } from "@/domain/phone";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

const patchClientSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).nullable().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "clients", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage clients", id);
  }

  const { id: clientId } = await context.params;
  if (!z.uuid().safeParse(clientId).success) {
    return apiError(404, "CLIENT_NOT_FOUND", "No client with this ID", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = patchClientSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { name, phone, email, archived } = parsed.data;

  let normalizedPhone: string | null | undefined = undefined;
  if (phone !== undefined) {
    if (phone === null || phone === "") {
      normalizedPhone = null;
    } else {
      normalizedPhone = normalizePhone(phone);
      if (normalizedPhone === null) {
        return apiError(422, "INVALID_PHONE", "The phone number is not valid", id, {
          fieldErrors: [{ field: "phone", code: "invalid_format", message: "Invalid phone number" }],
        });
      }
    }
  }

  try {
    const updated = await withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, clientId), isNull(clients.anonymizedAt)))
        .limit(1);
      if (!existing) return null;

      const now = new Date();
      const patch: Record<string, unknown> = {
        updatedBy: actor.userId,
        updatedAt: now,
        version: sql`${clients.version} + 1`,
      };
      if (name !== undefined) patch.name = name;
      if (normalizedPhone !== undefined) patch.normalizedPhone = normalizedPhone;
      if (email !== undefined) patch.email = email;
      /*
       * Hiding and bringing back, from the one field. Restoring can collide:
       * since 0046 an archived client no longer reserves its phone or address,
       * so somebody else may hold one by now. That surfaces as the unique
       * violation the catch below already names, which is a far better answer
       * than the index raising through it as a 500.
       */
      if (archived === true) patch.archivedAt = now;
      if (archived === false) patch.archivedAt = null;

      const [row] = await tx
        .update(clients)
        .set(patch)
        .where(eq(clients.id, clientId))
        .returning({ id: clients.id, name: clients.name });

      return row ?? null;
    });

    if (!updated) {
      return apiError(404, "CLIENT_NOT_FOUND", "No client with this ID", id);
    }

    return apiSuccess({ id: updated.id, name: updated.name }, id);
  } catch (error) {
    if (isUniqueViolation(error, "client_org_phone_idx")) {
      return apiError(409, "CLIENT_PHONE_EXISTS", "A client with this phone already exists", id);
    }
    if (isUniqueViolation(error, "client_org_email_idx")) {
      return apiError(409, "CLIENT_EMAIL_EXISTS", "A client with this email already exists", id);
    }
    throw error;
  }
}

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
