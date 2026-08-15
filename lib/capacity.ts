import { and, eq, gte, isNull, lt, or } from "drizzle-orm";

import { availabilityExceptions, locations, scheduleRules, specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import {
  scheduledMinutesInMonth,
  type CapacityExceptionInput,
  type CapacityRuleInput,
} from "@/domain/capacity";
import type { Weekday } from "@/domain/timezone";

/**
 * The month's rota, read for the capacity figures.
 *
 * Two queries and no per-day work in SQL: the expansion of a weekly pattern
 * into dates is `domain/capacity.ts`'s job, where it is a pure function and can
 * be tested against DST without a database.
 *
 * Archived specialists are left out. Someone who no longer works here offers no
 * hours; counting their old rota would inflate capacity and report the studio
 * as idle for a chair that does not exist.
 */
export async function loadMonthRota(
  tx: TenantTransaction,
  month: string,
): Promise<{ scheduledMinutes: number }> {
  const bounds = {
    start: new Date(`${month}-01T00:00:00.000Z`),
    end: new Date(`${month}-01T00:00:00.000Z`),
  };
  bounds.end.setUTCMonth(bounds.end.getUTCMonth() + 1);

  // A day either side, matching the overhang the domain walks: a shift local to
  // another timezone can start before the month opens and still belong to it.
  const from = new Date(bounds.start.getTime() - 86_400_000);
  const to = new Date(bounds.end.getTime() + 86_400_000);

  const rules = await tx
    .select({
      specialistId: scheduleRules.specialistId,
      timezone: locations.timezone,
      weekday: scheduleRules.weekday,
      startMinute: scheduleRules.startMinute,
      endMinute: scheduleRules.endMinute,
      effectiveFrom: scheduleRules.effectiveFrom,
      effectiveTo: scheduleRules.effectiveTo,
    })
    .from(scheduleRules)
    .innerJoin(locations, eq(locations.id, scheduleRules.locationId))
    .innerJoin(specialists, eq(specialists.id, scheduleRules.specialistId))
    .where(
      and(
        isNull(specialists.archivedAt),
        // A rule that ended before this month, or starts after it, cannot put an
        // hour in it. The rest is decided by `ruleAppliesOn`, day by day.
        or(isNull(scheduleRules.effectiveTo), gte(scheduleRules.effectiveTo, from.toISOString().slice(0, 10))),
        lt(scheduleRules.effectiveFrom, to.toISOString().slice(0, 10)),
      ),
    );

  const exceptions = await tx
    .select({
      specialistId: availabilityExceptions.specialistId,
      kind: availabilityExceptions.kind,
      start: availabilityExceptions.startsAt,
      end: availabilityExceptions.endsAt,
    })
    .from(availabilityExceptions)
    .innerJoin(specialists, eq(specialists.id, availabilityExceptions.specialistId))
    .where(
      and(
        isNull(specialists.archivedAt),
        lt(availabilityExceptions.startsAt, to),
        gte(availabilityExceptions.endsAt, from),
      ),
    );

  const ruleInputs: CapacityRuleInput[] = rules.map((rule) => ({
    ...rule,
    weekday: rule.weekday as Weekday,
  }));
  const exceptionInputs: CapacityExceptionInput[] = exceptions;

  return { scheduledMinutes: scheduledMinutesInMonth(ruleInputs, exceptionInputs, month) };
}
