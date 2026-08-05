import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { availabilityExceptions, locations, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Holidays, sick days and the Tuesday someone works late — roadmap section 7.6.
 *
 * Instants rather than a repeating rule, because an exception is a real
 * interval of time. The API speaks UTC (section 7.6) and the interface converts
 * through the location's timezone, so the two never disagree about which hour
 * was meant.
 *
 * A null location means every location: a day off is not taken at one address.
 */
const createExceptionSchema = z.object({
  specialist_id: z.uuid(),
  location_id: z.uuid().nullable().optional(),
  kind: z.enum(["available", "unavailable"]),
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  /**
   * A short operational label such as "отпуск" — never a medical or personal
   * note. Section 7.9 keeps PII out of scheduling data, and every manager in
   * the organization can read this field.
   */
  reason: z.string().trim().max(120).optional(),
});

/**
 * A master may block their own time; changing someone else's schedule takes the
 * organization-wide bookings scope from section 6.1.
 */
async function resolveOwnSpecialistId(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  userId: string,
) {
  const [own] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(eq(specialists.userId, userId))
    .limit(1);
  return own?.id ?? null;
}

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read schedules", id);
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const requestedSpecialist = url.searchParams.get("specialist_id");

  const rows = await withTenant(actor.organizationId, async (tx) => {
    const ownOnly = scopeFor(actor.role, "bookings") === "own";
    const ownSpecialistId = ownOnly
      ? ((await resolveOwnSpecialistId(tx, actor.userId)) ?? "00000000-0000-0000-0000-000000000000")
      : null;

    const conditions = [
      ownSpecialistId
        ? eq(availabilityExceptions.specialistId, ownSpecialistId)
        : requestedSpecialist
          ? eq(availabilityExceptions.specialistId, requestedSpecialist)
          : undefined,
      from ? gte(availabilityExceptions.endsAt, new Date(from)) : undefined,
      to ? lte(availabilityExceptions.startsAt, new Date(to)) : undefined,
    ].filter(Boolean);

    return tx
      .select({
        id: availabilityExceptions.id,
        specialist_id: availabilityExceptions.specialistId,
        location_id: availabilityExceptions.locationId,
        kind: availabilityExceptions.kind,
        starts_at: availabilityExceptions.startsAt,
        ends_at: availabilityExceptions.endsAt,
        reason: availabilityExceptions.reason,
      })
      .from(availabilityExceptions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(availabilityExceptions.startsAt));
  });

  return apiSuccess(rows, id);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage schedules", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createExceptionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const startsAt = new Date(parsed.data.starts_at);
  const endsAt = new Date(parsed.data.ends_at);
  if (endsAt.getTime() <= startsAt.getTime()) {
    return apiError(422, "INVALID_INTERVAL", "An exception must end after it starts", id, {
      fieldErrors: [{ field: "ends_at", code: "invalid_interval", message: "Must be after starts_at" }],
    });
  }

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [specialist] = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(eq(specialists.id, parsed.data.specialist_id))
      .limit(1);
    if (!specialist) return { failure: "SPECIALIST_NOT_FOUND" as const };

    if (!canManageCatalogue(actor.role, "bookings")) {
      const own = await resolveOwnSpecialistId(tx, actor.userId);
      if (own !== specialist.id) return { failure: "FORBIDDEN_SPECIALIST" as const };
    }

    if (parsed.data.location_id) {
      const [location] = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.id, parsed.data.location_id))
        .limit(1);
      if (!location) return { failure: "LOCATION_NOT_FOUND" as const };
    }

    const [created] = await tx
      .insert(availabilityExceptions)
      .values({
        organizationId: actor.organizationId,
        specialistId: specialist.id,
        locationId: parsed.data.location_id ?? null,
        kind: parsed.data.kind,
        startsAt,
        endsAt,
        reason: parsed.data.reason ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    // Section 7.4 asks for exceptions to be audited: blocking a day removes
    // slots clients could otherwise have taken, and opening one creates hours
    // nobody agreed to in the rota.
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "availability_exception.created",
      entityType: "availability_exception",
      entityId: created.id,
      after: {
        specialist_id: created.specialistId,
        kind: created.kind,
        starts_at: created.startsAt,
        ends_at: created.endsAt,
      },
      requestId: id,
    });

    return { created };
  });

  if ("failure" in outcome) {
    switch (outcome.failure) {
      case "SPECIALIST_NOT_FOUND":
        return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", id);
      case "LOCATION_NOT_FOUND":
        return apiError(404, "LOCATION_NOT_FOUND", "No location with this ID", id);
      case "FORBIDDEN_SPECIALIST":
        return apiError(403, "FORBIDDEN", "This role may only change its own schedule", id);
    }
  }

  return apiSuccess(
    {
      id: outcome.created.id,
      specialist_id: outcome.created.specialistId,
      location_id: outcome.created.locationId,
      kind: outcome.created.kind,
      starts_at: outcome.created.startsAt,
      ends_at: outcome.created.endsAt,
      reason: outcome.created.reason,
    },
    id,
    201,
  );
}

export async function DELETE(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "bookings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage schedules", id);
  }

  const exceptionId = new URL(request.url).searchParams.get("id");
  if (!exceptionId) {
    return apiError(422, "VALIDATION_ERROR", "An exception id is required", id, {
      fieldErrors: [{ field: "id", code: "required", message: "An exception id is required" }],
    });
  }

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(availabilityExceptions)
      .where(eq(availabilityExceptions.id, exceptionId))
      .limit(1);
    if (!existing) return { failure: "NOT_FOUND" as const };

    if (!canManageCatalogue(actor.role, "bookings")) {
      const own = await resolveOwnSpecialistId(tx, actor.userId);
      if (own !== existing.specialistId) return { failure: "FORBIDDEN_SPECIALIST" as const };
    }

    // Deleted outright rather than archived: unlike a booking or a price, an
    // exception is not a record of something that happened — it is a statement
    // about the future, and withdrawing it leaves the audit event behind.
    await tx.delete(availabilityExceptions).where(eq(availabilityExceptions.id, exceptionId));

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "availability_exception.deleted",
      entityType: "availability_exception",
      entityId: existing.id,
      before: {
        specialist_id: existing.specialistId,
        kind: existing.kind,
        starts_at: existing.startsAt,
        ends_at: existing.endsAt,
      },
      requestId: id,
    });

    return { removed: existing.id };
  });

  if ("failure" in outcome) {
    return outcome.failure === "NOT_FOUND"
      ? apiError(404, "EXCEPTION_NOT_FOUND", "No availability exception with this ID", id)
      : apiError(403, "FORBIDDEN", "This role may only change its own schedule", id);
  }

  return apiSuccess({ id: outcome.removed, deleted: true }, id);
}
