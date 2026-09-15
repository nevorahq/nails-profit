import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { locations, scheduleRules, specialistLocations } from "@/db/schema";
import { DEFAULT_WORKWEEK } from "@/domain/workspace-defaults";
import { anonymous, dataOf, signUp } from "../helpers/api";
import { isoDay, weekdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * Hiring somebody, and the row that decides whether a client can book them.
 *
 * `specialist_location` is what the public catalogue filters people by, and it
 * used to be written on one screen only — «Онлайн-запись», two selects deep. So
 * a studio added a master, saw them in the calendar, in the rota and in every
 * report, and its booking page went on offering one person. Nothing said why,
 * because nothing knew: the master was complete by every other measure.
 *
 * Written with the card now, for every active address, and so are the hours:
 * an address nobody has a rota at is «no_hours», which is the same invisibility
 * arrived at one row later. The studio with two addresses unticks what it does
 * not mean in «Онлайн-запись» and corrects the week there; the studio with one
 * — which is most of them — never had a choice to make here in the first place.
 */
const SETUP = {
  type: "studio" as const,
  currency: "MDL" as const,
  locale: "ru" as const,
  address: "Str. Ismail 33",
  timezone: "Europe/Chisinau",
  commission_basis_points: 4_000,
  services: [{ key: "manicure", price_minor: 30_000, duration_minutes: 60 }],
  workweek: { weekdays: [1, 2, 3, 4, 5], start: "08:00", end: "16:00" },
  publish_booking: true,
};

beforeAll(async () => {
  await resetDatabase();
  process.env.PUBLIC_BOOKING_ENABLED = "true";
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("a master added after the studio was registered", () => {
  test("is bookable by a client the moment the card exists", async () => {
    const owner = await signUp("bookable-owner@studio.example", "Belle Nails");
    const organization = dataOf<{ id: string; slug: string }>(
      await owner.post("/api/v1/organizations", { ...SETUP, owner_works: true, owner_name: "Irina" }),
    );

    const hired = dataOf<{ id: string }>(
      await owner.post("/api/v1/specialists", {
        name: "Ana",
        default_rule: { type: "percentage", basis_points: 4_000 },
      }),
    );

    const links = await adminDb
      .select()
      .from(specialistLocations)
      .where(eq(specialistLocations.specialistId, hired.id));
    expect(links).toHaveLength(1);

    /*
     * And the consequence the studio actually notices: the page now offers a
     * choice. The selector appears at «more than one master», so a hire that
     * did not reach the catalogue left the page looking exactly as it did
     * before anyone was hired.
     */
    const [place] = dataOf<{ id: string }[]>(await owner.get("/api/v1/locations"));
    const catalogue = dataOf<{ services: { specialists: { name: string }[] }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/${organization.slug}/catalog?location_id=${place.id}`,
      ),
    );
    expect(catalogue.services).toHaveLength(1);
    expect(catalogue.services[0].specialists.map((person) => person.name).sort()).toEqual([
      "Ana",
      "Irina",
    ]);
  });

  test("works the studio's own week from the day the card is made", async () => {
    const owner = await signUp("bookable-rota@studio.example", "Rota Nails");
    const organization = dataOf<{ id: string; slug: string }>(
      await owner.post("/api/v1/organizations", { ...SETUP, owner_works: false }),
    );

    const hired = dataOf<{ id: string }>(
      await owner.post("/api/v1/specialists", {
        name: "Vera",
        default_rule: { type: "percentage", basis_points: 4_000 },
      }),
    );

    /*
     * An address with no hours in it makes nobody bookable — `bookabilityOf`
     * calls it «no_hours» — so the card that arrived complete by every other
     * measure was still invisible to every client, and the only screen that
     * said so was «Онлайн-запись», two selects deep. Пн–Пт 08:00–16:00: the
     * week the studio already works, not a guess about this person.
     */
    const rota = await adminDb
      .select()
      .from(scheduleRules)
      .where(eq(scheduleRules.specialistId, hired.id));

    expect(rota.map((rule) => rule.weekday).sort()).toEqual([...DEFAULT_WORKWEEK.weekdays]);
    expect([...new Set(rota.map((rule) => `${rule.startMinute}-${rule.endMinute}`))]).toEqual([
      `${DEFAULT_WORKWEEK.startMinute}-${DEFAULT_WORKWEEK.endMinute}`,
    ]);

    // And the whole point of it: a client asking for a working day is offered
    // times with her in them, without anybody opening a second screen.
    const [place] = dataOf<{ id: string }[]>(await owner.get("/api/v1/locations"));
    const [service] = dataOf<{ id: string }[]>(await owner.get("/api/v1/services"));
    const availability = dataOf<{ slots: { specialist_id: string }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/${organization.slug}/availability?location_id=${place.id}` +
          `&service_id=${service.id}&specialist_id=${hired.id}&date=${isoDay(weekdayAhead(3))}`,
      ),
    );
    expect(availability.slots.length).toBeGreaterThan(0);
    expect(availability.slots.every((slot) => slot.specialist_id === hired.id)).toBe(true);
  });

  test("is created without complaint when there is no address to work at", async () => {
    // An archived address is not somewhere anybody works, and a studio whose
    // only address is archived must still be able to catalogue people.
    const owner = await signUp("bookable-addressless@studio.example", "Quiet Nails");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", { ...SETUP, owner_works: false }),
    );
    await adminDb
      .update(locations)
      .set({ status: "archived" })
      .where(eq(locations.organizationId, organization.id));

    const hired = dataOf<{ id: string }>(
      await owner.post("/api/v1/specialists", {
        name: "Maria",
        default_rule: { type: "percentage", basis_points: 4_000 },
      }),
    );

    expect(
      await adminDb
        .select()
        .from(specialistLocations)
        .where(eq(specialistLocations.specialistId, hired.id)),
    ).toHaveLength(0);
  });
});
