import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { locations, scheduleRules, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { parseLocalDate, parseLocalTime, weekdays } from "@/domain/timezone";
import { recordAuditEvent } from "@/lib/audit";
import { bookingModuleRefusal } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Weekly working patterns, roadmap section 7.6.
 *
 * PUT replaces the pattern for one specialist at one location from a given
 * local date onward, replacing what stood there before:
 * the previous rules are closed rather than deleted, by setting their
 * `effective_to` to the new `effective_from`. Exclusive end, inclusive start —
 * the same handover the commission rules use, so a question about last Tuesday
 * still resolves to the schedule that was in force last Tuesday.
 *
 * That matters more here than it looks: a booking taken three weeks ago was
 * offered against the pattern of the day, and rewriting history would make
 * every past appointment look like it had been placed outside working hours.
 */
const intervalSchema = z.object({
  weekday: z.union(weekdays.map((day) => z.literal(day)) as [z.ZodLiteral<1>, ...z.ZodLiteral<number>[]]),
  /** `HH:MM` local, because that is what a person writes on a rota. */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

const putRulesSchema = z.object({
  specialist_id: z.uuid(),
  location_id: z.uuid(),
  /** When the new pattern starts applying; defaults to today in UTC terms. */
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  intervals: z.array(intervalSchema).max(28),
});

const MIDNIGHT_END = 24 * 60;

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
  const requestedSpecialist = url.searchParams.get("specialist_id");
  const requestedLocation = url.searchParams.get("location_id");
  const includeExpired = url.searchParams.get("include_expired") === "true";

  const rows = await withTenant(actor.organizationId, async (tx) => {
    // Section 6.1: a Master sees their own schedule. Resolved from the linked
    // specialist row rather than from a query parameter, which the caller owns.
    let ownSpecialistId: string | null = null;
    if (scopeFor(actor.role, "bookings") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, actor.userId))
        .limit(1);
      ownSpecialistId = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    const conditions = [
      ownSpecialistId
        ? eq(scheduleRules.specialistId, ownSpecialistId)
        : requestedSpecialist
          ? eq(scheduleRules.specialistId, requestedSpecialist)
          : undefined,
      requestedLocation ? eq(scheduleRules.locationId, requestedLocation) : undefined,
      // Closed rules stay for history; the default view is what is in force.
      includeExpired
        ? undefined
        : or(isNull(scheduleRules.effectiveTo), sql`${scheduleRules.effectiveTo} > current_date`),
    ].filter(Boolean);

    return tx
      .select({
        id: scheduleRules.id,
        specialist_id: scheduleRules.specialistId,
        location_id: scheduleRules.locationId,
        weekday: scheduleRules.weekday,
        start_minute: scheduleRules.startMinute,
        end_minute: scheduleRules.endMinute,
        effective_from: scheduleRules.effectiveFrom,
        effective_to: scheduleRules.effectiveTo,
      })
      .from(scheduleRules)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(scheduleRules.weekday), asc(scheduleRules.startMinute));
  });

  return apiSuccess(rows, id);
}

export async function PUT(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  const canManageAll = canManageCatalogue(actor.role, "bookings");
  const canManageOwn = can(actor.role, "bookings", "write") && scopeFor(actor.role, "bookings") === "own";
  if (!canManageAll && !canManageOwn) {
    return apiError(403, "FORBIDDEN", "This role cannot manage schedules", id);
  }
  const disabled = await bookingModuleRefusal(actor.organizationId, id, "write");
  if (disabled) return disabled;

  const body = await request.json().catch(() => null);
  const parsed = putRulesSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  // Section 6.1: a Master may only update their own schedule.
  if (canManageOwn && !canManageAll) {
    const [own] = await withTenant(actor.organizationId, (tx) =>
      tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, actor.userId))
        .limit(1),
    );
    if (!own || own.id !== parsed.data.specialist_id) {
      return apiError(403, "FORBIDDEN", "Masters can only manage their own schedule", id);
    }
  }

  const effectiveFrom = parseLocalDate(parsed.data.effective_from);
  if (!effectiveFrom) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: [{ field: "effective_from", code: "invalid_date", message: "Not a calendar date" }],
    });
  }

  const intervals: { weekday: number; startMinute: number; endMinute: number }[] = [];
  for (const [index, interval] of parsed.data.intervals.entries()) {
    const startMinute = parseLocalTime(interval.start);
    // 24:00 is a legal end and nothing else is: a shift may run to midnight,
    // and `parseLocalTime` deliberately refuses it as a clock reading.
    const endMinute = interval.end === "24:00" ? MIDNIGHT_END : parseLocalTime(interval.end);

    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      return apiError(422, "INVALID_INTERVAL", "An interval must start before it ends", id, {
        fieldErrors: [
          { field: `intervals.${index}`, code: "invalid_interval", message: "Invalid local interval" },
        ],
      });
    }
    intervals.push({ weekday: interval.weekday, startMinute, endMinute });
  }

  // Overlaps inside one submitted pattern are rejected rather than merged: the
  // person filling in the rota has said something contradictory about their own
  // day, and silently merging it hides the mistake until a client books into it.
  for (const weekday of weekdays) {
    const sameDay = intervals
      .filter((interval) => interval.weekday === weekday)
      .sort((left, right) => left.startMinute - right.startMinute);

    for (let index = 1; index < sameDay.length; index += 1) {
      if (sameDay[index].startMinute < sameDay[index - 1].endMinute) {
        return apiError(422, "OVERLAPPING_INTERVALS", "Two intervals on the same weekday overlap", id, {
          details: { weekday },
        });
      }
    }
  }

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const [specialist] = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(eq(specialists.id, parsed.data.specialist_id))
      .limit(1);
    if (!specialist) return { failure: "SPECIALIST_NOT_FOUND" as const };

    const [location] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, parsed.data.location_id))
      .limit(1);
    if (!location) return { failure: "LOCATION_NOT_FOUND" as const };

    // A rule that has not started yet is replaced outright: closing it on its
    // own start date would leave a row valid for no day at all, which is what
    // the effective-range constraint refuses. Correcting a rota before it takes
    // effect is a correction, not a handover, and leaves nothing to preserve.
    const superseded = await tx
      .delete(scheduleRules)
      .where(
        and(
          eq(scheduleRules.specialistId, specialist.id),
          eq(scheduleRules.locationId, location.id),
          gte(scheduleRules.effectiveFrom, parsed.data.effective_from),
        ),
      )
      .returning({ id: scheduleRules.id });

    // What did apply is closed rather than deleted, from the day the new
    // pattern starts: a booking taken last Tuesday was offered against the
    // schedule of last Tuesday, and that has to remain answerable.
    const closed = await tx
      .update(scheduleRules)
      .set({
        effectiveTo: parsed.data.effective_from,
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${scheduleRules.version} + 1`,
      })
      .where(
        and(
          eq(scheduleRules.specialistId, specialist.id),
          eq(scheduleRules.locationId, location.id),
          lt(scheduleRules.effectiveFrom, parsed.data.effective_from),
          or(isNull(scheduleRules.effectiveTo), sql`${scheduleRules.effectiveTo} > ${parsed.data.effective_from}`),
        ),
      )
      .returning({ id: scheduleRules.id });

    const created =
      intervals.length === 0
        ? []
        : await tx
            .insert(scheduleRules)
            .values(
              intervals.map((interval) => ({
                organizationId: actor.organizationId,
                specialistId: specialist.id,
                locationId: location.id,
                weekday: interval.weekday,
                startMinute: interval.startMinute,
                endMinute: interval.endMinute,
                effectiveFrom: parsed.data.effective_from,
                createdBy: actor.userId,
                updatedBy: actor.userId,
              })),
            )
            .returning({ id: scheduleRules.id });

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "schedule.replaced",
      entityType: "specialist",
      entityId: specialist.id,
      after: {
        location_id: location.id,
        effective_from: parsed.data.effective_from,
        closed: closed.length,
        superseded: superseded.length,
        created: created.length,
      },
      requestId: id,
    });

    return { closed: closed.length, superseded: superseded.length, created: created.length };
  });

  if ("failure" in outcome) {
    return outcome.failure === "SPECIALIST_NOT_FOUND"
      ? apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", id)
      : apiError(404, "LOCATION_NOT_FOUND", "No location with this ID", id);
  }

  return apiSuccess(
    {
      specialist_id: parsed.data.specialist_id,
      location_id: parsed.data.location_id,
      effective_from: parsed.data.effective_from,
      closed_rules: outcome.closed,
      superseded_rules: outcome.superseded,
      created_rules: outcome.created,
    },
    id,
    201,
  );
}
