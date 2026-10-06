import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  bookingAccessTokens,
  bookings,
  clients,
  notificationOutbox,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, hasConstraint, scopeFor, seesClientNotes } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { mayActOnClient } from "@/lib/client-access";
import { flushStorageDeletions, queueClientPhotoDeletions } from "@/lib/visit-photos";
import { isUniqueViolation } from "@/lib/db-errors";
import { normalizePhone } from "@/domain/phone";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

const patchClientSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).nullable().optional(),
  archived: z.boolean().optional(),
  /**
   * The studio's note about this client. Trimmed, and an empty one is no note:
   * clearing the field is how a note is removed.
   */
  notes: z.string().trim().max(2000).nullable().optional(),
});

/**
 * One client's card: contacts and the studio's note, within the caller's
 * scope — a Master's own clients only, an Analyst without contacts or note.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "clients", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read clients", id);
  }

  const { id: clientId } = await context.params;
  if (!z.uuid().safeParse(clientId).success) {
    return apiError(404, "CLIENT_NOT_FOUND", "No client with this ID", id);
  }

  const client = await withTenant(actor.organizationId, async (tx) => {
    // Checked before the read, and answered the same as an unknown id: a
    // colleague's client is not something a Master learns exists.
    if (!(await mayActOnClient(tx, actor, clientId))) return null;
    const [row] = await tx
      .select({
        id: clients.id,
        name: clients.name,
        phone: clients.normalizedPhone,
        email: clients.email,
        notes: clients.notes,
        archivedAt: clients.archivedAt,
      })
      .from(clients)
      .where(and(eq(clients.id, clientId), isNull(clients.anonymizedAt)))
      .limit(1);
    return row ?? null;
  });

  if (!client) return apiError(404, "CLIENT_NOT_FOUND", "No client with this ID", id);

  const hidePii = hasConstraint(actor.role, "clients", "exclude_pii");
  return apiSuccess(
    {
      id: client.id,
      name: client.name,
      ...(hidePii ? {} : { phone: client.phone, email: client.email }),
      ...(seesClientNotes(actor.role) ? { notes: client.notes } : {}),
      archived: client.archivedAt !== null,
    },
    id,
  );
}

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

  const { name, phone, email, archived, notes } = parsed.data;

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
      // A Master changes their own clients only; anybody else's is a 404, the
      // same answer an id from another studio gets.
      if (!(await mayActOnClient(tx, actor, clientId))) return null;

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
      if (notes !== undefined) patch.notes = notes ? notes : null;
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
    let bookedNamesCleared = 0;
    if (bookingIds.length > 0) {
      /*
       * The appointments stay — they are the studio's own record of work done —
       * but the name a request was made under is this person's, the same as the
       * one on the card being anonymized. It is cleared here rather than left
       * for the card's own `UPDATE`, because it lives on the booking row and
       * nothing else would ever come back for it.
       */
      bookedNamesCleared = (
        await tx
          .update(bookings)
          .set({ clientNameSnapshot: null, updatedBy: actor.userId, updatedAt: now })
          .where(and(inArray(bookings.id, bookingIds), isNotNull(bookings.clientNameSnapshot)))
          .returning({ id: bookings.id })
      ).length;

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

    /*
     * Photos of their work go entirely. A note can be emptied and a name
     * replaced; a picture of somebody's hands has nothing to keep once it is
     * not theirs. The rows now, the objects after the commit.
     */
    const photosRemoved = await queueClientPhotoDeletions(tx, actor.organizationId, existing.id);

    const [anonymized] = await tx
      .update(clients)
      .set({
        name: "Deleted client",
        normalizedPhone: null,
        email: null,
        // Where to write is a fact about a person, and it goes with them.
        contactChannels: null,
        // And so is what the studio wrote down about them.
        notes: null,
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
        booked_names_cleared: bookedNamesCleared,
        access_tokens_revoked: tokensRevoked,
        notifications_dropped: notificationsDropped,
        photos_removed: photosRemoved,
      },
      requestId: requestIdentifier,
    });

    return { id: anonymized.id, anonymizedAt: anonymized.anonymizedAt, alreadyAnonymized: false };
  });

  // RLS makes an ID from another tenant indistinguishable from an unknown ID.
  if (!outcome) {
    return apiError(404, "CLIENT_NOT_FOUND", "No client with this ID", requestIdentifier);
  }
  await flushStorageDeletions(actor.organizationId);

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
