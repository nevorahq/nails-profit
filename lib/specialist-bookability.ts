import { eq, inArray } from "drizzle-orm";

import { bookingSettings, locations, scheduleRules, specialistLocations } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";

/** Where one master works, and on which days — the answer for one card. */
export type SpecialistPlace = Readonly<{
  locationId: string;
  name: string;
  published: boolean;
  /** Weekdays with hours at this address, 1 = Monday. Empty means none. */
  weekdays: readonly number[];
}>;

export type BookabilityFacts = Readonly<{
  /** Addresses a client can actually open — active and published. */
  publishedLocationIds: readonly string[];
  /** Per specialist id, in the shape `domain/bookability.ts` asks for. */
  places: ReadonlyMap<string, readonly SpecialistPlace[]>;
}>;

/**
 * Where each master works and when, for the screens that are about the master
 * rather than about the rota.
 *
 * «Мастера» and a master's own card answered four questions about a person —
 * their rate, their exceptions, their services, their account — and not the one
 * the studio asks the day after hiring somebody: can a client book them yet.
 * The two rows that decide it are written on «Онлайн-запись», two selects deep,
 * and nothing on the card said they existed.
 *
 * Read here rather than on that screen so the card can state the answer and
 * link to where it is changed. Three small tables, no per-master queries: a
 * studio has a handful of addresses and a handful of people.
 */
export async function loadBookabilityFacts(tx: TenantTransaction): Promise<BookabilityFacts> {
  const places = await tx
    .select({
      id: locations.id,
      name: locations.name,
      status: locations.status,
      publicStatus: bookingSettings.publicStatus,
    })
    .from(locations)
    .leftJoin(bookingSettings, eq(bookingSettings.locationId, locations.id));

  const byLocation = new Map(places.map((place) => [place.id, place]));
  const publishedLocationIds = places
    .filter((place) => place.status === "active" && place.publicStatus === "published")
    .map((place) => place.id);

  const assignments = await tx
    .select({
      specialistId: specialistLocations.specialistId,
      locationId: specialistLocations.locationId,
    })
    .from(specialistLocations);

  const ids = [...new Set(assignments.map((row) => row.locationId))];
  const rota = ids.length
    ? await tx
        .select({
          specialistId: scheduleRules.specialistId,
          locationId: scheduleRules.locationId,
          weekday: scheduleRules.weekday,
        })
        .from(scheduleRules)
        .where(inArray(scheduleRules.locationId, ids))
    : [];

  const grouped = new Map<string, SpecialistPlace[]>();
  for (const link of assignments) {
    const place = byLocation.get(link.locationId);
    if (!place) continue;
    const weekdays = [
      ...new Set(
        rota
          .filter(
            (rule) =>
              rule.specialistId === link.specialistId && rule.locationId === link.locationId,
          )
          .map((rule) => rule.weekday),
      ),
    ].sort((a, b) => a - b);

    const list = grouped.get(link.specialistId) ?? [];
    list.push({
      locationId: link.locationId,
      name: place.name,
      published: place.status === "active" && place.publicStatus === "published",
      weekdays,
    });
    grouped.set(link.specialistId, list);
  }

  return { publishedLocationIds, places: grouped };
}

/** The two lists `bookabilityOf` wants, out of what one master's places say. */
export function factsFor(places: readonly SpecialistPlace[] | undefined) {
  return {
    assignedLocationIds: (places ?? []).map((place) => place.locationId),
    rotaLocationIds: (places ?? [])
      .filter((place) => place.weekdays.length > 0)
      .map((place) => place.locationId),
  };
}
