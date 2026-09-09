import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { bookingSettings, scheduleRules, specialistLocations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { bookabilityOf } from "@/domain/bookability";
import { factsFor, loadBookabilityFacts } from "@/lib/specialist-bookability";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createLocation,
  createOrganization,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * Where each master works and when, read the way «Мастера» and a master's own
 * card now read it.
 *
 * The rule itself is pinned by `domain/bookability.test.ts`; what only a
 * database can answer is whether the three tables it is fed from are joined the
 * way the public page joins them — an assignment row, hours for that same pair,
 * and a location that is both active and published.
 */
describe("where a master works", () => {
  let organizationId: string;
  let centruId: string;
  let specialistId: string;

  async function publish(locationId: string) {
    await adminDb
      .update(bookingSettings)
      .set({ publicStatus: "published" })
      .where(eq(bookingSettings.locationId, locationId));
  }

  async function assign(locationId: string) {
    await adminDb.insert(specialistLocations).values({ organizationId, specialistId, locationId });
  }

  async function roster(locationId: string, weekday: number) {
    await adminDb.insert(scheduleRules).values({
      organizationId,
      specialistId,
      locationId,
      weekday,
      startMinute: 9 * 60,
      endMinute: 18 * 60,
      effectiveFrom: "2026-01-01",
    });
  }

  async function verdict() {
    const facts = await withTenant(organizationId, (tx) => loadBookabilityFacts(tx));
    return bookabilityOf({
      publishedLocationIds: facts.publishedLocationIds,
      ...factsFor(facts.places.get(specialistId)),
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    const owner = await createUser();
    organizationId = (await createOrganization({ ownerId: owner.id })).id;
    centruId = (await createLocation(organizationId, { name: "Центр" })).id;
    specialistId = (await createSpecialist(organizationId)).id;
  });

  it("reads a master with an address and hours as reachable", async () => {
    await publish(centruId);
    await assign(centruId);
    await roster(centruId, 1);

    expect(await verdict()).toBe("bookable");
  });

  it("does not count a draft address", async () => {
    // Assigned and rostered, and the page is not open: the studio sees the
    // week filled in, a client sees nothing.
    await assign(centruId);
    await roster(centruId, 1);

    expect(await verdict()).toBe("no_address");
  });

  it("separates «нет адреса» from «нет часов»", async () => {
    await publish(centruId);
    await assign(centruId);

    // The two are different sentences on screen, and different work.
    expect(await verdict()).toBe("no_hours");
  });

  it("names the days the card prints", async () => {
    await publish(centruId);
    await assign(centruId);
    await roster(centruId, 3);
    await roster(centruId, 5);

    const facts = await withTenant(organizationId, (tx) => loadBookabilityFacts(tx));
    expect(facts.places.get(specialistId)).toEqual([
      { locationId: centruId, name: "Центр", published: true, weekdays: [3, 5] },
    ]);
  });

  it("keeps hours belonging to the address they were written for", async () => {
    /*
     * Assigned to both, rostered at one. The card lists both addresses and
     * only one of them carries days — the half-filled state that read as ready
     * while each screen was asked separately.
     */
    const botanica = await createLocation(organizationId, { name: "Ботаника" });
    await publish(centruId);
    await assign(centruId);
    await assign(botanica.id);
    await roster(botanica.id, 2);

    const facts = await withTenant(organizationId, (tx) => loadBookabilityFacts(tx));
    const places = facts.places.get(specialistId) ?? [];
    expect(places.find((place) => place.locationId === centruId)?.weekdays).toEqual([]);
    expect(places.find((place) => place.locationId === botanica.id)?.weekdays).toEqual([2]);
    expect(await verdict()).toBe("no_hours");
  });
});
