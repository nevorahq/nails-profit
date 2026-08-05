import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";

import {
  addOns,
  availabilityExceptions,
  bookingSettings,
  locations,
  scheduleRules,
  services,
  specialistLocations,
  specialistServices,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import {
  findNextAvailableDates,
  generateSlots,
  type AvailabilityExceptionInput,
  type AvailabilitySettings,
  type ScheduleRuleInput,
  type Slot,
  type SlotSearch,
} from "@/domain/availability";
import type { Interval } from "@/domain/interval";
import {
  formatLocalDate,
  toZonedParts,
  type LocalDate,
  type Weekday,
} from "@/domain/timezone";
import type { BookingLineInput } from "@/lib/booking-service";
import { activeBookingIntervals, activeHoldIntervals } from "@/lib/booking-service";
import type { LocalizedText } from "@/i18n/localized-text";

/**
 * Everything the availability engine needs, loaded from the tenant.
 *
 * The engine itself takes values and returns slots; this is the only place that
 * knows those values come from a database. Keeping the two apart is what lets
 * the DST cases be tested without fixtures, and what stops a query creeping
 * into the middle of a loop over a day's minutes.
 */
export type BookingDraft = Readonly<{
  durationMinutes: number;
  priceMinor: number;
  requiresWorkplace: boolean;
  lines: readonly BookingLineInput[];
}>;

/**
 * What is being booked, priced and timed at this moment.
 *
 * The duration is the specialist's own when they have an override: the same
 * service takes a beginner longer than the master who trained them, and a slot
 * search that ignores that either overbooks one or wastes the other's day.
 * Add-on deltas apply on top either way.
 */
export async function loadBookingDraft(
  tx: TenantTransaction,
  input: { serviceId: string; addOnIds: readonly string[]; specialistId: string },
): Promise<BookingDraft | null> {
  const [service] = await tx
    .select()
    .from(services)
    .where(and(eq(services.id, input.serviceId), isNull(services.archivedAt)))
    .limit(1);
  if (!service) return null;

  const [assignment] = await tx
    .select({
      durationOverrideMinutes: specialistServices.durationOverrideMinutes,
      requiresWorkplace: specialistServices.requiresWorkplace,
    })
    .from(specialistServices)
    .where(
      and(
        eq(specialistServices.specialistId, input.specialistId),
        eq(specialistServices.serviceId, service.id),
      ),
    )
    .limit(1);

  const chosen =
    input.addOnIds.length > 0
      ? await tx.select().from(addOns).where(inArray(addOns.id, [...input.addOnIds]))
      : [];
  if (chosen.length !== input.addOnIds.length) return null;

  const baseDuration = assignment?.durationOverrideMinutes ?? service.durationMinutes ?? 0;
  const durationMinutes =
    baseDuration + chosen.reduce((total, addOn) => total + addOn.durationDeltaMinutes, 0);

  const priceMinor =
    (service.priceMinor ?? 0) + chosen.reduce((total, addOn) => total + addOn.priceDeltaMinor, 0);

  // A negative total is not a discount, it is a mistake in the add-on deltas,
  // and quoting it would be worse than refusing to quote at all.
  if (durationMinutes <= 0 || priceMinor < 0) return null;

  const lines: BookingLineInput[] = [
    {
      kind: "service",
      serviceId: service.id,
      addOnId: null,
      nameSnapshot: (service.name ?? {}) as LocalizedText,
      priceMinor: service.priceMinor ?? 0,
      durationMinutes: baseDuration,
    },
    ...chosen.map((addOn) => ({
      kind: "add_on" as const,
      serviceId: null,
      addOnId: addOn.id,
      nameSnapshot: (addOn.name ?? {}) as LocalizedText,
      priceMinor: Math.max(0, addOn.priceDeltaMinor),
      durationMinutes: addOn.durationDeltaMinutes,
    })),
  ];

  return {
    durationMinutes,
    priceMinor,
    requiresWorkplace: assignment?.requiresWorkplace ?? false,
    lines,
  };
}

export type SlotContext = Readonly<{
  timezone: string;
  settings: AvailabilitySettings;
  confirmationMode: "instant" | "manual";
  confirmationTtlMinutes: number;
  publicStatus: "draft" | "published" | "paused";
}>;

/** Location, timezone and the numbers that narrow what may be offered. */
export async function loadSlotContext(
  tx: TenantTransaction,
  locationId: string,
): Promise<SlotContext | null> {
  const [row] = await tx
    .select({
      timezone: locations.timezone,
      status: locations.status,
      publicStatus: bookingSettings.publicStatus,
      slotStepMinutes: bookingSettings.slotStepMinutes,
      minLeadMinutes: bookingSettings.minLeadMinutes,
      maxAdvanceDays: bookingSettings.maxAdvanceDays,
      bufferBeforeMinutes: bookingSettings.bufferBeforeMinutes,
      bufferAfterMinutes: bookingSettings.bufferAfterMinutes,
      confirmationMode: bookingSettings.confirmationMode,
      confirmationTtlMinutes: bookingSettings.confirmationTtlMinutes,
    })
    .from(locations)
    .innerJoin(bookingSettings, eq(bookingSettings.locationId, locations.id))
    .where(eq(locations.id, locationId))
    .limit(1);

  if (!row || row.status !== "active") return null;

  return {
    timezone: row.timezone,
    settings: {
      slotStepMinutes: row.slotStepMinutes,
      minLeadMinutes: row.minLeadMinutes,
      maxAdvanceDays: row.maxAdvanceDays,
      bufferBeforeMinutes: row.bufferBeforeMinutes,
      bufferAfterMinutes: row.bufferAfterMinutes,
    },
    confirmationMode: row.confirmationMode,
    confirmationTtlMinutes: row.confirmationTtlMinutes,
    publicStatus: row.publicStatus,
  };
}

async function loadRules(tx: TenantTransaction, specialistId: string, locationId: string) {
  const rows = await tx
    .select({
      weekday: scheduleRules.weekday,
      startMinute: scheduleRules.startMinute,
      endMinute: scheduleRules.endMinute,
      effectiveFrom: scheduleRules.effectiveFrom,
      effectiveTo: scheduleRules.effectiveTo,
    })
    .from(scheduleRules)
    .where(
      and(eq(scheduleRules.specialistId, specialistId), eq(scheduleRules.locationId, locationId)),
    );

  return rows.map(
    (row): ScheduleRuleInput => ({
      weekday: row.weekday as Weekday,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    }),
  );
}

async function loadExceptions(
  tx: TenantTransaction,
  specialistId: string,
  locationId: string,
  window: Interval,
): Promise<AvailabilityExceptionInput[]> {
  const rows = await tx
    .select({
      kind: availabilityExceptions.kind,
      startsAt: availabilityExceptions.startsAt,
      endsAt: availabilityExceptions.endsAt,
    })
    .from(availabilityExceptions)
    .where(
      and(
        eq(availabilityExceptions.specialistId, specialistId),
        // A null location means every location: a day off is not taken at one
        // address.
        or(isNull(availabilityExceptions.locationId), eq(availabilityExceptions.locationId, locationId)),
        lt(availabilityExceptions.startsAt, window.end),
        gt(availabilityExceptions.endsAt, window.start),
      ),
    );

  return rows.map((row) => ({ kind: row.kind, start: row.startsAt, end: row.endsAt }));
}

export type SlotQuery = Readonly<{
  locationId: string;
  specialistId: string;
  durationMinutes: number;
  date: LocalDate;
  now: Date;
}>;

/**
 * Slots for one specialist on one local day.
 *
 * The busy list is bookings *and* live holds: a slot someone is filling in a
 * form for is not free, and offering it produces the conflict the hold exists
 * to prevent.
 */
export async function loadSlotSearch(
  tx: TenantTransaction,
  query: SlotQuery,
  context: SlotContext,
): Promise<SlotSearch> {
  // A day's window, widened by a day at each end: a shift can run past midnight
  // and an exception can start the evening before.
  const window: Interval = {
    start: new Date(Date.UTC(query.date.year, query.date.month - 1, query.date.day - 1)),
    end: new Date(Date.UTC(query.date.year, query.date.month - 1, query.date.day + 2)),
  };

  const [rules, exceptions, bookedIntervals, heldIntervals] = await Promise.all([
    loadRules(tx, query.specialistId, query.locationId),
    loadExceptions(tx, query.specialistId, query.locationId, window),
    activeBookingIntervals(tx, query.specialistId, window),
    activeHoldIntervals(tx, query.specialistId, query.now),
  ]);

  return {
    date: query.date,
    timezone: context.timezone,
    durationMinutes: query.durationMinutes,
    rules,
    exceptions,
    busy: [...bookedIntervals, ...heldIntervals],
    settings: context.settings,
    now: query.now,
  };
}

export async function slotsFor(
  tx: TenantTransaction,
  query: SlotQuery,
  context: SlotContext,
): Promise<Slot[]> {
  return generateSlots(await loadSlotSearch(tx, query, context));
}

/**
 * The nearest days that still have room, for the `SLOT_UNAVAILABLE` response.
 *
 * Section 7.5 asks a conflict to come back with alternatives, and section 7.8
 * asks for the soonest dates rather than an empty calendar. Losing a race is
 * the moment a client is most likely to give up, so the answer has to contain
 * the next thing to do.
 */
export async function alternativeSlots(
  tx: TenantTransaction,
  query: SlotQuery,
  context: SlotContext,
  options: { limit?: number } = {},
): Promise<{ date: string; slots: Slot[] }[]> {
  const search = await loadSlotSearch(tx, query, context);
  const { date, ...rest } = search;
  void date;

  return findNextAvailableDates(rest, query.date, { limit: options.limit ?? 3 });
}

/** Whether a specialist may be booked at this location for this service. */
export async function assertAssignable(
  tx: TenantTransaction,
  input: { specialistId: string; locationId: string; serviceId: string },
): Promise<"ok" | "specialist_not_found" | "not_at_location" | "service_not_offered"> {
  const [specialist] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(and(eq(specialists.id, input.specialistId), isNull(specialists.archivedAt)))
    .limit(1);
  if (!specialist) return "specialist_not_found";

  const [atLocation] = await tx
    .select({ id: specialistLocations.id })
    .from(specialistLocations)
    .where(
      and(
        eq(specialistLocations.specialistId, input.specialistId),
        eq(specialistLocations.locationId, input.locationId),
      ),
    )
    .limit(1);
  if (!atLocation) return "not_at_location";

  const [offered] = await tx
    .select({ id: specialistServices.id })
    .from(specialistServices)
    .where(
      and(
        eq(specialistServices.specialistId, input.specialistId),
        eq(specialistServices.serviceId, input.serviceId),
      ),
    )
    .limit(1);
  // An empty assignment list means "does everything": a solo studio should not
  // have to enumerate its own catalogue before it can take a booking.
  if (!offered) {
    const [anyAssignment] = await tx
      .select({ id: specialistServices.id })
      .from(specialistServices)
      .where(eq(specialistServices.specialistId, input.specialistId))
      .limit(1);
    if (anyAssignment) return "service_not_offered";
  }

  return "ok";
}

/** `2026-08-05` for the next day that has room, used in error details. */
export function describeAlternatives(alternatives: { date: string; slots: Slot[] }[]) {
  return alternatives.map((entry) => ({
    date: entry.date,
    slots: entry.slots.slice(0, 6).map((slot) => slot.start.toISOString()),
  }));
}

/** The local date a booking falls on, for the response and for logs. */
export function bookingLocalDate(start: Date, timezone: string) {
  const parts = toZonedParts(start, timezone);
  return formatLocalDate({ year: parts.year, month: parts.month, day: parts.day });
}
