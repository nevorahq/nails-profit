import type { TenantTransaction } from "@/db/tenant";
import { withTenant } from "@/db/tenant";
import { addLocalDays, formatLocalDate, localToUtc, type LocalDate } from "@/domain/timezone";
import {
  alternativeSlots,
  loadBookingDraftFor,
  loadSlotContext,
  slotsFor,
} from "@/lib/availability-service";
import { occupyingBookingIntervals } from "@/lib/booking-service";
import {
  loadPublicCatalog,
  publicSpecialistsFor,
  type PublicSpecialist,
} from "@/lib/public-booking";

export type PublicAvailabilityInput = Readonly<{
  slug: string;
  locationId: string;
  serviceId: string;
  addOnIds: readonly string[];
  specialistId?: string | null;
  date: LocalDate;
  /** Set when a client is moving this booking, so its own hour stays offerable. */
  excludeBookingId?: string | null;
  /**
   * Every service of the booking being moved, when the studio booked several
   * in one sitting. The public page books one; an appointment made at the
   * desk can hold more, and moving it must find room for all of it rather
   * than for its first service. Absent means `serviceId` with `addOnIds`.
   */
  items?: readonly Readonly<{ serviceId: string; addOnIds: readonly string[] }>[];
  now: Date;
}>;

function itemsOf(input: PublicAvailabilityInput) {
  return input.items ?? [{ serviceId: input.serviceId, addOnIds: input.addOnIds }];
}

export type PublicSlot = Readonly<{
  starts_at: string;
  ends_at: string;
  specialist_id: string;
  specialist_name: string;
  duration_minutes: number;
  price_minor: number;
}>;

type Candidate = Readonly<{
  person: PublicSpecialist;
  bookedMinutes: number;
  slots: PublicSlot[];
}>;

async function candidateFor(
  tx: TenantTransaction,
  input: PublicAvailabilityInput,
  person: PublicSpecialist,
  timezone: string,
): Promise<Candidate | null> {
  const draft = await loadBookingDraftFor(tx, { items: itemsOf(input), specialistId: person.id });
  if (!draft) return null;

  const context = await loadSlotContext(tx, input.locationId);
  if (!context || context.publicStatus !== "published") return null;

  const slots = await slotsFor(
    tx,
    {
      locationId: input.locationId,
      specialistId: person.id,
      durationMinutes: draft.durationMinutes,
      date: input.date,
      excludeBookingId: input.excludeBookingId ?? null,
      now: input.now,
    },
    context,
  );

  const day = {
    start: localToUtc(input.date, 0, timezone),
    end: localToUtc(addLocalDays(input.date, 1), 0, timezone),
  };
  const occupied = await occupyingBookingIntervals(tx, person.id, day, input.excludeBookingId ?? null);
  const bookedMinutes = occupied.reduce(
    (total, interval) => total + (interval.end.getTime() - interval.start.getTime()) / 60_000,
    0,
  );

  return {
    person,
    bookedMinutes,
    slots: slots.map((slot) => ({
      starts_at: slot.start.toISOString(),
      ends_at: slot.end.toISOString(),
      specialist_id: person.id,
      specialist_name: person.name,
      duration_minutes: draft.durationMinutes,
      price_minor: draft.priceMinor,
    })),
  };
}

/** Whoever may be booked for the whole sitting, or null when nobody can. */
async function resolvePeople(tx: TenantTransaction, input: PublicAvailabilityInput) {
  // Whoever does every service of the sitting, not only the first.
  let people = await publicSpecialistsFor(tx, input.locationId, itemsOf(input)[0].serviceId);
  for (const item of itemsOf(input).slice(1)) {
    const able = new Set(
      (await publicSpecialistsFor(tx, input.locationId, item.serviceId)).map((person) => person.id),
    );
    people = people.filter((person) => able.has(person.id));
  }
  if (input.specialistId) {
    people = people.filter((person) => person.id === input.specialistId);
  }
  return people.length === 0 ? null : people;
}

/** The slots of `input.date`, one per start time unless a master was named. */
async function slotsOnDay(
  tx: TenantTransaction,
  input: PublicAvailabilityInput,
  people: PublicSpecialist[],
  timezone: string,
): Promise<PublicSlot[]> {
  const candidates = (
    await Promise.all(
      people.map((person) =>
        candidateFor(tx, input, person, timezone),
      ),
    )
  ).filter((candidate): candidate is Candidate => candidate !== null);

  const flattened = candidates.flatMap((candidate) =>
    candidate.slots.map((slot) => ({
      slot,
      bookedMinutes: candidate.bookedMinutes,
      sortOrder: candidate.person.sortOrder,
    })),
  );
  flattened.sort(
    (left, right) =>
      left.slot.starts_at.localeCompare(right.slot.starts_at) ||
      left.bookedMinutes - right.bookedMinutes ||
      left.sortOrder - right.sortOrder ||
      left.slot.specialist_id.localeCompare(right.slot.specialist_id),
  );

  const seen = new Set<string>();
  return flattened
    .filter(({ slot }) => {
      // A named specialist keeps all their slots. “Any” keeps the best person
      // for each wall-clock start.
      if (input.specialistId) return true;
      if (seen.has(slot.starts_at)) return false;
      seen.add(slot.starts_at);
      return true;
    })
    .map(({ slot }) => slot);
}

async function catalogueFor(input: PublicAvailabilityInput) {
  const catalogue = await loadPublicCatalog(input.slug, input.locationId);
  if (!catalogue) return null;

  for (const item of itemsOf(input)) {
    const service = catalogue.dto.services.find((entry) => entry.id === item.serviceId);
    if (!service) return null;
    const allowedAddOns = new Set(service.add_ons.map((addOn) => addOn.id));
    if (item.addOnIds.some((id) => !allowedAddOns.has(id))) return null;
  }
  return catalogue;
}

/** The longest ribbon of days one request may ask for. */
export const MAX_AVAILABILITY_DAYS = 14;

/**
 * The slots of several consecutive days from one request.
 *
 * The public page draws a ribbon of the coming days with the times under it.
 * Asking for each day separately would spend the page's availability budget
 * (`PUBLIC_BOOKING_AVAILABILITY_RULE`) on tapping through the ribbon, so the
 * whole stretch is answered at once, in one transaction, and the page picks
 * the day it shows from the answer. Days are the location's own, from
 * `input.date`; a day with no free time is still listed so the ribbon can say so.
 */
export async function loadPublicAvailabilityRange(
  input: PublicAvailabilityInput & Readonly<{ days: number }>,
): Promise<
  | Readonly<{
      organizationId: string;
      timezone: string;
      currency: string;
      days: { date: string; slots: PublicSlot[] }[];
    }>
  | null
> {
  const catalogue = await catalogueFor(input);
  if (!catalogue) return null;
  const count = Math.min(Math.max(Math.trunc(input.days), 1), MAX_AVAILABILITY_DAYS);

  return withTenant(catalogue.organization.id, async (tx) => {
    const people = await resolvePeople(tx, input);
    if (!people) return null;

    const context = await loadSlotContext(tx, input.locationId);
    if (!context || context.publicStatus !== "published") return null;

    const days: { date: string; slots: PublicSlot[] }[] = [];
    for (let offset = 0; offset < count; offset += 1) {
      const date = addLocalDays(input.date, offset);
      days.push({
        date: formatLocalDate(date),
        slots: await slotsOnDay(tx, { ...input, date }, people, catalogue.location.timezone),
      });
    }

    return {
      organizationId: catalogue.organization.id,
      timezone: catalogue.location.timezone,
      currency: catalogue.organization.currency,
      days,
    };
  });
}

/**
 * Public slots without exposing the underlying rota.
 *
 * “Any available” is reduced to one deterministic specialist per start time:
 * least booked minutes that local day, then configured sort order, then id.
 */
export async function loadPublicAvailability(
  input: PublicAvailabilityInput,
): Promise<
  | Readonly<{
      organizationId: string;
      timezone: string;
      currency: string;
      confirmationMode: "instant" | "manual";
      slots: PublicSlot[];
      nearestDates: { date: string; slot_count: number }[];
    }>
  | null
> {
  const catalogue = await catalogueFor(input);
  if (!catalogue) return null;

  return withTenant(catalogue.organization.id, async (tx) => {
    const people = await resolvePeople(tx, input);
    if (!people) return null;

    const slots = await slotsOnDay(tx, input, people, catalogue.location.timezone);

    const context = await loadSlotContext(tx, input.locationId);
    if (!context || context.publicStatus !== "published") return null;

    const nearestDates =
      slots.length > 0
        ? []
        : Array.from(
            (
              await Promise.all(
                people.map(async (person) => {
                  const draft = await loadBookingDraftFor(tx, {
                    items: itemsOf(input),
                    specialistId: person.id,
                  });
                  if (!draft) return [];

                  const alternatives = await alternativeSlots(
                    tx,
                    {
                      locationId: input.locationId,
                      specialistId: person.id,
                      durationMinutes: draft.durationMinutes,
                      date: input.date,
                      excludeBookingId: input.excludeBookingId ?? null,
                      now: input.now,
                    },
                    context,
                    { limit: 3 },
                  );
                  return alternatives.map((entry) => ({
                    date: entry.date,
                    starts: entry.slots.map((slot) => slot.start.toISOString()),
                  }));
                }),
              )
            )
              .flat()
              .reduce((byDate, entry) => {
                const starts = byDate.get(entry.date) ?? new Set<string>();
                entry.starts.forEach((start) => starts.add(start));
                byDate.set(entry.date, starts);
                return byDate;
              }, new Map<string, Set<string>>()),
          )
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 3)
            .map(([date, starts]) => ({ date, slot_count: starts.size }));

    return {
      organizationId: catalogue.organization.id,
      timezone: catalogue.location.timezone,
      currency: catalogue.organization.currency,
      confirmationMode: context.confirmationMode,
      slots,
      nearestDates,
    };
  });
}
