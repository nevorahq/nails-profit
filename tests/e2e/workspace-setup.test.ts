import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  bookingSettings,
  commissionRules,
  expenses,
  locations,
  organizations,
  scheduleRules,
  services,
  specialistLocations,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { defaultCommissionBasisPointsFor } from "@/domain/workspace-defaults";
import { loadStartScreen } from "@/lib/first-numbers";
import { loadOnboarding } from "@/lib/onboarding";
import { anonymous, dataOf, errorCodeOf, signUp } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * Registration as one answer instead of five.
 *
 * The studio used to be created with four fields and then asked, one screen at
 * a time, for everything that makes those fields useful: a rate, a priced
 * service, an address, working hours, the rent. Every one of them is now on the
 * form, and what this file holds to is that they are actually written — in the
 * same transaction, for the right people, and refused as a whole when one of
 * them cannot be.
 */

const FULL_SETUP = {
  type: "solo" as const,
  currency: "MDL" as const,
  locale: "ru" as const,
  address: "Str. Ismail 33, Chisinau",
  timezone: "Europe/Chisinau",
  commission_basis_points: 4_000,
  services: [
    { key: "manicure", price_minor: 35_000, duration_minutes: 60 },
    { key: "pedicure", price_minor: 45_000, duration_minutes: 90 },
  ],
  workweek: { weekdays: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" },
  rent_minor: 600_000,
};

beforeAll(async () => {
  await resetDatabase();
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("a workspace created from the setup form", () => {
  /*
   * The rate the form sends, by format. Somebody working alone is written a
   * rule at zero — still a rule, so the first visit closes — and her first
   * screen shows the whole price as what she keeps instead of an imputed wage.
   */
  test("writes somebody working alone a rule at zero, and still costs her catalogue", async () => {
    const owner = await signUp("setup-solo-zero@studio.example");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", {
        name: "Zero Solo",
        ...FULL_SETUP,
        commission_basis_points: defaultCommissionBasisPointsFor("solo"),
      }),
    );

    const rules = await adminDb
      .select()
      .from(commissionRules)
      .where(eq(commissionRules.organizationId, organization.id));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ type: "percentage", basisPoints: 0, serviceId: null });

    const screen = await withTenant(organization.id, (tx) => loadStartScreen(tx, "ru", organization.id));
    expect(screen?.kind).toBe("numbers");
    if (screen?.kind !== "numbers") return;
    const manicure = screen.rows.find((row) => row.priceMinor === 35_000);
    expect(manicure).toMatchObject({ commissionMinor: 0, contributionMarginMinor: 35_000 });
  });

  test("writes a studio's cards at the studio rate", async () => {
    const owner = await signUp("setup-studio-rate@studio.example");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", {
        name: "Rate Studio",
        ...FULL_SETUP,
        type: "studio",
        owner_works: true,
        owner_name: "Irina",
        commission_basis_points: defaultCommissionBasisPointsFor("studio"),
      }),
    );

    const rules = await adminDb
      .select()
      .from(commissionRules)
      .where(eq(commissionRules.organizationId, organization.id));
    expect(rules.map((rule) => rule.basisPoints)).toEqual([4_000]);
  });

  test("arrives able to answer, without a single follow-up screen", async () => {
    const owner = await signUp("setup-full@studio.example");
    const organization = dataOf<{ id: string; timezone: string }>(
      await owner.post("/api/v1/organizations", { name: "Setup Studio", ...FULL_SETUP }),
    );

    // The address, which is what a rota belongs to and what the public page is
    // served from. Named after the studio; only the street was typed.
    const [place] = await adminDb
      .select()
      .from(locations)
      .where(eq(locations.organizationId, organization.id));
    expect(place.name).toBe("Setup Studio");
    expect(place.slug).toBe("setup-studio");
    expect(place.address).toBe(FULL_SETUP.address);
    expect(place.timezone).toBe("Europe/Chisinau");
    expect(organization.timezone).toBe("Europe/Chisinau");

    // The rate, written for the owner's own card — the one the organization
    // created — rather than for a second person nobody hired.
    const people = await adminDb
      .select()
      .from(specialists)
      .where(eq(specialists.organizationId, organization.id));
    expect(people).toHaveLength(1);
    expect(people[0].isPrincipal).toBe(true);
    /*
     * Named after the studio, because sign-up asks for the studio's name and a
     * workspace of one *is* the studio: «Setup Studio» in the calendar is the
     * truth, not a placeholder.
     */
    expect(people[0].name).toBe("Setup Studio");

    expect(people[0].userId).not.toBeNull();

    const rules = await adminDb
      .select()
      .from(commissionRules)
      .where(eq(commissionRules.organizationId, organization.id));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      specialistId: people[0].id,
      type: "percentage",
      basisPoints: 4_000,
      // Unrestricted: it pays on every service, including the ones added next
      // year, which is what makes the checklist step complete.
      serviceId: null,
    });

    /*
     * The row a client's booking page depends on. Nothing used to write it
     * outside «Онлайн-запись», so a master could have a rota, appear in the
     * calendar, and be dropped from the public catalogue without a word.
     */
    const assignments = await adminDb
      .select()
      .from(specialistLocations)
      .where(eq(specialistLocations.organizationId, organization.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ specialistId: people[0].id, locationId: place.id });

    // The catalogue, named by the product in all three languages and priced by
    // the owner.
    const catalogue = await adminDb
      .select()
      .from(services)
      .where(eq(services.organizationId, organization.id));
    expect(catalogue).toHaveLength(2);
    const manicure = catalogue.find((row) => row.priceMinor === 35_000)!;
    expect(manicure.name).toMatchObject({ ru: "Маникюр", ro: "Manichiură", en: "Manicure" });
    expect(manicure.durationMinutes).toBe(60);
    expect(manicure.currency).toBe("MDL");

    // The working week, for that person at that address.
    const rota = await adminDb
      .select()
      .from(scheduleRules)
      .where(eq(scheduleRules.organizationId, organization.id));
    expect(rota).toHaveLength(5);
    expect(new Set(rota.map((row) => row.weekday))).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(rota.every((row) => row.startMinute === 480 && row.endMinute === 1_080)).toBe(true);
    expect(rota.every((row) => row.locationId === place.id)).toBe(true);

    // The rent, as the recurring row the month's report reads.
    const ledger = await adminDb
      .select()
      .from(expenses)
      .where(eq(expenses.organizationId, organization.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      category: "rent",
      amountMinor: 600_000,
      currency: "MDL",
      isRecurring: true,
    });
    expect(ledger[0].name).toBe("Аренда");
    expect(ledger[0].recurringFrom).toBe(`${new Date().toISOString().slice(0, 7)}-01`);

    // And the whole point of the above: nothing is left to do before the
    // product can say what the work is worth.
    const progress = await withTenant(organization.id, (tx) => loadOnboarding(tx));
    expect(progress.complete).toBe(true);
  });

  test("remembers the wish to book online, and opens nothing until the prices are confirmed", async () => {
    /*
     * Registration used to publish here, on a suggested price and hours nobody
     * chose. It keeps the tick as an intention now — the opening-setup screen
     * leads with «открыть запись» because of it — and the page opens only from
     * that screen, on prices a person has confirmed (`opening-setup.test.ts`
     * holds the rest). Requests still wait for the owner when it does open.
     */
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    const owner = await signUp("setup-published@studio.example");
    const organization = dataOf<{ id: string; slug: string }>(
      await owner.post("/api/v1/organizations", {
        name: "Published Studio",
        ...FULL_SETUP,
        publish_booking: true,
      }),
    );

    const [row] = await adminDb
      .select({
        bookingAccess: organizations.bookingAccess,
        wantsOnlineBooking: organizations.wantsOnlineBooking,
        setupConfirmedAt: organizations.setupConfirmedAt,
      })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(row).toEqual({ bookingAccess: "calendar", wantsOnlineBooking: true, setupConfirmedAt: null });

    const [settings] = await adminDb
      .select()
      .from(bookingSettings)
      .where(eq(bookingSettings.organizationId, organization.id));
    expect(settings.publicStatus).toBe("draft");
    expect(settings.confirmationMode).toBe("manual");

    // And a client who has the link meets a closed door, not the suggestions.
    const page = await anonymous.get(`/api/v1/public/booking/${organization.slug}`);
    expect(page.status).toBe(404);
  });

  test("leaves the booking page alone unless the form asked for it", async () => {
    // The rollout ladder in `db/schema.ts` is explicit that the public page
    // comes after the calendar, so every caller that says nothing keeps the
    // rung it always had.
    const owner = await signUp("setup-unpublished@studio.example");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", { name: "Quiet Studio", ...FULL_SETUP }),
    );

    const [row] = await adminDb
      .select({ bookingAccess: organizations.bookingAccess })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(row.bookingAccess).toBe("calendar");

    const [settings] = await adminDb
      .select()
      .from(bookingSettings)
      .where(eq(bookingSettings.organizationId, organization.id));
    expect(settings.publicStatus).toBe("draft");
    expect(settings.confirmationMode).toBe("instant");
    const [intent] = await adminDb
      .select({ wantsOnlineBooking: organizations.wantsOnlineBooking })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(intent.wantsOnlineBooking).toBe(false);
  });

  test("gives a studio's named masters a card, the same rate and the same week", async () => {
    const owner = await signUp("setup-studio@studio.example");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", {
        name: "Team Studio",
        ...FULL_SETUP,
        type: "studio",
        owner_works: false,
        masters: ["Ana", "Maria"],
      }),
    );

    const people = await adminDb
      .select()
      .from(specialists)
      .where(eq(specialists.organizationId, organization.id));
    expect(people.map((row) => row.name).sort()).toEqual(["Ana", "Maria"]);
    /*
     * Cards, not accounts, and nobody is marked as the principal: this owner
     * said they do not take clients, and a card created for them anyway would
     * stand in the calendar, in the public catalogue and — through the
     * principal mark — in the month's profit.
     */
    expect(people.every((row) => row.userId === null && !row.isPrincipal)).toBe(true);

    const rules = await adminDb
      .select()
      .from(commissionRules)
      .where(eq(commissionRules.organizationId, organization.id));
    expect(rules).toHaveLength(2);

    const rota = await adminDb
      .select()
      .from(scheduleRules)
      .where(eq(scheduleRules.organizationId, organization.id));
    expect(rota).toHaveLength(10);

    // Both of them bookable at the studio's address, not only rota'd.
    expect(
      await adminDb
        .select()
        .from(specialistLocations)
        .where(eq(specialistLocations.organizationId, organization.id)),
    ).toHaveLength(2);
  });

  test("catalogues a studio's owner as a master when they say they take clients", async () => {
    /*
     * The case the product could not describe at all. `type` decided it:
     * `solo` meant «I am the master», `studio` meant nothing — so the woman who
     * owns a studio of three and works at a table herself had to find «Это я»
     * on a screen she had no reason to open, and until she did, every visit she
     * closed counted the cost of her own work as money leaving the business.
     */
    const owner = await signUp("setup-working-owner@studio.example");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", {
        name: "Working Owner Studio",
        ...FULL_SETUP,
        type: "studio",
        owner_works: true,
        masters: ["Ana"],
      }),
    );

    const people = await adminDb
      .select()
      .from(specialists)
      .where(eq(specialists.organizationId, organization.id));
    expect(people).toHaveLength(2);

    const ownerCard = people.find((row) => row.userId === owner.userId);
    expect(ownerCard).toBeDefined();
    // The two facts that cannot be recovered by guessing later: whose account
    // the card is, and that this person's commission never left the business.
    expect(ownerCard!.isPrincipal).toBe(true);
    // And the mark belongs to exactly one of them.
    expect(people.filter((row) => row.isPrincipal)).toHaveLength(1);

    // Paid, rota'd and bookable on the same terms as the person they hired.
    expect(
      await adminDb
        .select()
        .from(commissionRules)
        .where(eq(commissionRules.organizationId, organization.id)),
    ).toHaveLength(2);
    expect(
      await adminDb
        .select()
        .from(scheduleRules)
        .where(eq(scheduleRules.organizationId, organization.id)),
    ).toHaveLength(10);
    expect(
      await adminDb
        .select()
        .from(specialistLocations)
        .where(eq(specialistLocations.organizationId, organization.id)),
    ).toHaveLength(2);
  });

  test("lets a studio's owner say who she is, rather than be her own studio", async () => {
    /*
     * The other half of naming the studio at sign-up. For one person the two
     * names are the same thing; for a studio of three they are not, and a
     * client picking from «Studio Belle», «Ana» and «Maria» would be reading a
     * bug.
     */
    const owner = await signUp("setup-owner-name@studio.example", "Belle Studio");
    const organization = dataOf<{ id: string; name: string }>(
      await owner.post("/api/v1/organizations", {
        ...FULL_SETUP,
        type: "studio",
        owner_works: true,
        owner_name: "Irina",
        masters: ["Ana"],
      }),
    );

    expect(organization.name).toBe("Belle Studio");
    const people = await adminDb
      .select()
      .from(specialists)
      .where(eq(specialists.organizationId, organization.id));
    expect(people.map((row) => row.name).sort()).toEqual(["Ana", "Irina"]);
    expect(people.find((row) => row.userId === owner.userId)!.name).toBe("Irina");
  });

  test("lets somebody register a solo workspace they do not work in", async () => {
    // The other side of the same field, and the reason it is a field rather
    // than a reading of `type`: the answer is the owner's, not the format's.
    const owner = await signUp("setup-absent-owner@studio.example");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", {
        name: "Absent Owner",
        ...FULL_SETUP,
        owner_works: false,
      }),
    );

    expect(
      await adminDb.select().from(specialists).where(eq(specialists.organizationId, organization.id)),
    ).toHaveLength(0);
  });

  test("names the studio after the account, in letters a client can read", async () => {
    /*
     * The form stopped asking for a name. The account was created a minute
     * earlier under the owner's own — usually Cyrillic in the pilot — and it
     * has to come out as something that reads on a booking link, because that
     * is where a client meets it.
     */
    const owner = await signUp("setup-named@studio.example", "Ирина Попеску");
    const organization = dataOf<{ id: string; name: string; slug: string }>(
      await owner.post("/api/v1/organizations", { ...FULL_SETUP }),
    );

    expect(organization.name).toBe("Irina Popesku");
    expect(organization.slug).toBe("irina-popesku");
  });

  test("falls back to the address rather than failing over a name nobody typed", async () => {
    // An account named in a script the table does not know. A registration must
    // not be refused over a field the owner was never shown.
    const owner = await signUp("setup-unnamed@studio.example", "美甲");
    const organization = dataOf<{ id: string; name: string }>(
      await owner.post("/api/v1/organizations", { ...FULL_SETUP }),
    );

    expect(organization.name).toBe("setup-unnamed");
  });

  test("still creates exactly what the four original fields created", async () => {
    // Every fixture and half the suite calls this endpoint with the fields it
    // has always had. They must keep getting a workspace, not a validation
    // error about a setup they know nothing about.
    const owner = await signUp("setup-minimal@studio.example");
    const organization = dataOf<{ id: string }>(
      await owner.post("/api/v1/organizations", { name: "Minimal", type: "solo" }),
    );

    const [row] = await adminDb
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(row.timezone).toBe("Europe/Chisinau");

    expect(
      await adminDb.select().from(commissionRules).where(eq(commissionRules.organizationId, organization.id)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(services).where(eq(services.organizationId, organization.id)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(expenses).where(eq(expenses.organizationId, organization.id)),
    ).toHaveLength(0);
    // The address is the one addition every caller gets: without it there is
    // nowhere to write a rota, and no public page to publish.
    expect(
      await adminDb.select().from(locations).where(eq(locations.organizationId, organization.id)),
    ).toHaveLength(1);
  });

  test("refuses a working day that ends before it starts, and registers nothing", async () => {
    const owner = await signUp("setup-interval@studio.example");
    const refused = await owner.post("/api/v1/organizations", {
      name: "Backwards",
      ...FULL_SETUP,
      workweek: { weekdays: [1], start: "18:00", end: "08:00" },
    });

    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("VALIDATION_ERROR");
    /*
     * Checked before the transaction opens, which is the whole reason this test
     * exists: a refusal after it had begun would roll the registration back,
     * and the second attempt is met with MEMBERSHIP_EXISTS — a studio locked
     * out of the product by its own typo.
     */
    expect(dataOf<unknown[]>(await owner.get("/api/v1/organizations"))).toHaveLength(0);
  });

  test("refuses a kind of work the catalogue does not know", async () => {
    const owner = await signUp("setup-service@studio.example");
    const refused = await owner.post("/api/v1/organizations", {
      name: "Unknown Work",
      ...FULL_SETUP,
      services: [{ key: "levitation", price_minor: 1_000, duration_minutes: 30 }],
    });

    expect(refused.status).toBe(422);
    expect(dataOf<unknown[]>(await owner.get("/api/v1/organizations"))).toHaveLength(0);
  });
});
