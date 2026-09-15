import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { locations, specialistLocations } from "@/db/schema";
import { anonymous, dataOf, signUp } from "../helpers/api";
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
 * Written with the card now, for every active address. The studio with two
 * addresses unticks what it does not mean in «Онлайн-запись»; the studio with
 * one — which is most of them — never had a choice to make here in the first
 * place.
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
