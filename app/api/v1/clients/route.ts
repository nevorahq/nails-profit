import { asc, isNull } from "drizzle-orm";
import { z } from "zod";

import { clients } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { normalizePhone } from "@/domain/phone";
import { can, scopeFor } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Minimal client card, roadmap P0. Contacts are optional so a walk-in can be
 * recorded, and the phone is normalized to E.164 on the way in (LOC-005) —
 * which is what makes the partial unique index meaningful.
 */
const createClientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
});

export async function GET(request: Request) {
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

  const rows = await withTenant(actor.organizationId, (tx) =>
    tx.select().from(clients).where(isNull(clients.archivedAt)).orderBy(asc(clients.name)),
  );

  // Section 6.1: an Analyst reads client history "без телефонов и email".
  const hidePii = scopeFor(actor.role, "clients") === "all" && !can(actor.role, "clients", "write");

  return apiSuccess(
    rows.map((client) => ({
      id: client.id,
      name: client.name,
      ...(hidePii ? {} : { phone: client.normalizedPhone, email: client.email }),
      anonymized: client.anonymizedAt !== null,
    })),
    id,
  );
}

export async function POST(request: Request) {
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

  const body = await request.json().catch(() => null);
  const parsed = createClientSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  let normalizedPhone: string | null = null;
  if (parsed.data.phone) {
    normalizedPhone = normalizePhone(parsed.data.phone);
    if (normalizedPhone === null) {
      return apiError(422, "INVALID_PHONE", "The phone number is not valid", id, {
        fieldErrors: [{ field: "phone", code: "invalid_format", message: "Invalid phone number" }],
      });
    }
  }

  try {
    const client = await withTenant(actor.organizationId, async (tx) => {
      const [created] = await tx
        .insert(clients)
        .values({
          organizationId: actor.organizationId,
          name: parsed.data.name,
          normalizedPhone,
          email: parsed.data.email ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning();

      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        eventType: "client.created",
        entityType: "client",
        entityId: created.id,
        // The name is PII; the audit records that a client was created, not who.
        after: { has_phone: normalizedPhone !== null, has_email: created.email !== null },
        requestId: id,
      });

      return created;
    });

    return apiSuccess({ id: client.id, name: client.name, phone: client.normalizedPhone }, id, 201);
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
