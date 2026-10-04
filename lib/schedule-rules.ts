import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";

import { scheduleRules } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { recordAuditEvent } from "@/lib/audit";

export type WeeklyInterval = Readonly<{ weekday: number; startMinute: number; endMinute: number }>;

/**
 * One specialist's week at one address, replaced from a local date onward.
 *
 * Shared by `PUT /availability/rules` and the opening-setup screen, which both
 * say «from today, this is the week» and must leave the same history behind: a
 * rule that has not started yet is replaced outright, and one that did apply is
 * closed on the new start date rather than deleted, because a booking taken
 * last Tuesday was offered against last Tuesday's week and has to stay
 * answerable. The caller has already checked the intervals and that both the
 * specialist and the address are this organization's.
 */
export async function replaceWeeklySchedule(
  tx: TenantTransaction,
  input: Readonly<{
    organizationId: string;
    actorUserId: string;
    specialistId: string;
    locationId: string;
    effectiveFrom: string;
    intervals: readonly WeeklyInterval[];
    requestId: string;
  }>,
) {
  // A rule that has not started yet is replaced outright: closing it on its
  // own start date would leave a row valid for no day at all, which is what
  // the effective-range constraint refuses. Correcting a rota before it takes
  // effect is a correction, not a handover, and leaves nothing to preserve.
  const superseded = await tx
    .delete(scheduleRules)
    .where(
      and(
        eq(scheduleRules.specialistId, input.specialistId),
        eq(scheduleRules.locationId, input.locationId),
        gte(scheduleRules.effectiveFrom, input.effectiveFrom),
      ),
    )
    .returning({ id: scheduleRules.id });

  // What did apply is closed rather than deleted, from the day the new
  // pattern starts: a booking taken last Tuesday was offered against the
  // schedule of last Tuesday, and that has to remain answerable.
  const closed = await tx
    .update(scheduleRules)
    .set({
      effectiveTo: input.effectiveFrom,
      updatedBy: input.actorUserId,
      updatedAt: new Date(),
      version: sql`${scheduleRules.version} + 1`,
    })
    .where(
      and(
        eq(scheduleRules.specialistId, input.specialistId),
        eq(scheduleRules.locationId, input.locationId),
        lt(scheduleRules.effectiveFrom, input.effectiveFrom),
        or(isNull(scheduleRules.effectiveTo), sql`${scheduleRules.effectiveTo} > ${input.effectiveFrom}`),
      ),
    )
    .returning({ id: scheduleRules.id });

  const created =
    input.intervals.length === 0
      ? []
      : await tx
          .insert(scheduleRules)
          .values(
            input.intervals.map((interval) => ({
              organizationId: input.organizationId,
              specialistId: input.specialistId,
              locationId: input.locationId,
              weekday: interval.weekday,
              startMinute: interval.startMinute,
              endMinute: interval.endMinute,
              effectiveFrom: input.effectiveFrom,
              createdBy: input.actorUserId,
              updatedBy: input.actorUserId,
            })),
          )
          .returning({ id: scheduleRules.id });

  await recordAuditEvent(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    eventType: "schedule.replaced",
    entityType: "specialist",
    entityId: input.specialistId,
    after: {
      location_id: input.locationId,
      effective_from: input.effectiveFrom,
      closed: closed.length,
      superseded: superseded.length,
      created: created.length,
    },
    requestId: input.requestId,
  });

  return { closed: closed.length, superseded: superseded.length, created: created.length };
}
