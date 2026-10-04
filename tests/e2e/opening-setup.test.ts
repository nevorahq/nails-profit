import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bookingSettings, organizations, scheduleRules, services, specialists } from "@/db/schema";

import { anonymous, dataOf, errorCodeOf, signUp, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { inviteMember } from "../helpers/studio";

/**
 * «Ваш прайс и часы»: the screen a new studio has to pass before a client can
 * book it.
 *
 * Registration fills the catalogue and the week with suggestions and publishes
 * nothing. What this file holds to is that the page opens only from here, only
 * on the prices sent here, in one transaction with them — and that saving
 * without opening leaves it shut.
 */

const REGISTRATION = {
  type: "solo" as const,
  currency: "MDL" as const,
  locale: "ru" as const,
  address: "Str. Ismail 33, Chisinau",
  timezone: "Europe/Chisinau",
  commission_basis_points: 4_000,
  services: [{ key: "manicure", price_minor: 20_000, duration_minutes: 60 }],
  workweek: { weekdays: [1, 2, 3, 4, 5], start: "08:00", end: "16:00" },
  publish_booking: true,
};

const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

async function register(email: string, overrides: Record<string, unknown> = {}) {
  const owner = await signUp(email);
  const organization = dataOf<{ id: string; slug: string }>(
    await owner.post("/api/v1/organizations", { name: `Studio ${email.split("@")[0]}`, ...REGISTRATION, ...overrides }),
  );
  const [manicure] = await adminDb
    .select({ id: services.id })
    .from(services)
    .where(eq(services.organizationId, organization.id));
  return { owner, organization, manicureId: manicure.id };
}

async function stateOf(organizationId: string) {
  const [organization] = await adminDb
    .select({ bookingAccess: organizations.bookingAccess, setupConfirmedAt: organizations.setupConfirmedAt })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const [settings] = await adminDb
    .select({ publicStatus: bookingSettings.publicStatus })
    .from(bookingSettings)
    .where(eq(bookingSettings.organizationId, organizationId));
  return { ...organization, publicStatus: settings.publicStatus };
}

function confirm(owner: Actor, body: Record<string, unknown>) {
  return owner.post("/api/v1/organizations/setup", body);
}

beforeAll(async () => {
  process.env.PUBLIC_BOOKING_ENABLED = "true";
  await resetDatabase();
}, 60_000);

afterAll(async () => {
  if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
  else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
  await closeTestConnections();
});

describe("the opening-setup screen", () => {
  test("opens the page on the prices and the week it was sent, and only then", async () => {
    const { owner, organization, manicureId } = await register("opening-open@studio.example");
    expect((await anonymous.get(`/api/v1/public/booking/${organization.slug}`)).status).toBe(404);

    const saved = await confirm(owner, {
      services: [
        { id: manicureId, price_minor: 37_000, duration_minutes: 75 },
        { key: "pedicure", price_minor: 45_000, duration_minutes: 90 },
      ],
      workweek: { weekdays: [2, 3, 4, 5, 6], start: "10:00", end: "19:00" },
      open_booking: true,
    });
    expect(saved.status).toBe(200);
    expect(dataOf<{ published: boolean }>(saved).published).toBe(true);

    const state = await stateOf(organization.id);
    expect(state.bookingAccess).toBe("public");
    expect(state.publicStatus).toBe("published");
    expect(state.setupConfirmedAt).not.toBeNull();

    // What a client now sees is what was typed on the screen, not the suggestion.
    const [place] = dataOf<{ id: string }[]>(await owner.get("/api/v1/locations"));
    const catalogue = dataOf<{ services: { name: string; price_minor: number; duration_minutes: number }[] }>(
      await anonymous.get(`/api/v1/public/booking/${organization.slug}/catalog?location_id=${place.id}`),
    );
    expect(
      catalogue.services.map((service) => [service.name, service.price_minor, service.duration_minutes]).sort(),
    ).toEqual([
      ["Маникюр", 37_000, 75],
      ["Педикюр", 45_000, 90],
    ]);

    // And the owner works the week from the screen, Tuesday to Saturday.
    const [card] = await adminDb
      .select({ id: specialists.id })
      .from(specialists)
      .where(eq(specialists.organizationId, organization.id));
    const week = await adminDb
      .select({ weekday: scheduleRules.weekday, start: scheduleRules.startMinute, end: scheduleRules.endMinute })
      .from(scheduleRules)
      .where(and(eq(scheduleRules.specialistId, card.id), isNull(scheduleRules.effectiveTo)));
    expect(week.map((rule) => rule.weekday).sort()).toEqual([2, 3, 4, 5, 6]);
    expect(new Set(week.map((rule) => `${rule.start}-${rule.end}`))).toEqual(new Set([`${10 * 60}-${19 * 60}`]));
  });

  test("saved without opening, confirms the prices and leaves the page shut", async () => {
    const { owner, organization, manicureId } = await register("opening-later@studio.example");
    const saved = await confirm(owner, {
      services: [{ id: manicureId, price_minor: 25_000, duration_minutes: 60 }],
      workweek: { weekdays: [1, 2, 3], start: "09:00", end: "17:00" },
      open_booking: false,
    });
    expect(saved.status).toBe(200);
    expect(dataOf<{ published: boolean }>(saved).published).toBe(false);

    const state = await stateOf(organization.id);
    expect(state).toMatchObject({ bookingAccess: "calendar", publicStatus: "draft" });
    expect(state.setupConfirmedAt).not.toBeNull();
    expect((await anonymous.get(`/api/v1/public/booking/${organization.slug}`)).status).toBe(404);
  });

  test("takes a service off the price list when it is unticked, and keeps its history", async () => {
    const { owner, organization, manicureId } = await register("opening-archive@studio.example");
    await confirm(owner, {
      services: [{ key: "pedicure", price_minor: 45_000, duration_minutes: 90 }],
      archive_service_ids: [manicureId],
      workweek: { weekdays: [1], start: "09:00", end: "17:00" },
    });
    const rows = await adminDb
      .select({ id: services.id, archivedAt: services.archivedAt })
      .from(services)
      .where(eq(services.organizationId, organization.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === manicureId)?.archivedAt).not.toBeNull();
  });

  test("refuses a price nobody gave, and writes nothing", async () => {
    const { owner, organization, manicureId } = await register("opening-zero@studio.example");
    const refused = await confirm(owner, {
      services: [{ id: manicureId, price_minor: 0, duration_minutes: 60 }],
      workweek: { weekdays: [1, 2], start: "09:00", end: "17:00" },
      open_booking: true,
    });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("VALIDATION_ERROR");

    const state = await stateOf(organization.id);
    expect(state).toMatchObject({ bookingAccess: "calendar", publicStatus: "draft", setupConfirmedAt: null });
    const [manicure] = await adminDb.select().from(services).where(eq(services.id, manicureId));
    expect(manicure.priceMinor).toBe(20_000);
  });

  test("refuses a week with no day, and a day that ends before it starts", async () => {
    const { owner, manicureId } = await register("opening-week@studio.example");
    const service = { id: manicureId, price_minor: 20_000, duration_minutes: 60 };
    for (const workweek of [
      { weekdays: [], start: "09:00", end: "17:00" },
      { weekdays: [1], start: "17:00", end: "09:00" },
    ]) {
      const refused = await confirm(owner, { services: [service], workweek });
      expect(refused.status).toBe(422);
    }
  });

  test("is not offered a week for a studio whose owner does not work", async () => {
    const { owner, organization, manicureId } = await register("opening-studio@studio.example", {
      type: "studio",
      owner_works: false,
      masters: ["Ana"],
    });
    const refused = await confirm(owner, {
      services: [{ id: manicureId, price_minor: 20_000, duration_minutes: 60 }],
      workweek: { weekdays: [1], start: "09:00", end: "17:00" },
    });
    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe("NO_OWNER_CARD");

    // Without a week, the prices alone are confirmed, and Ana keeps hers.
    const saved = await confirm(owner, {
      services: [{ id: manicureId, price_minor: 30_000, duration_minutes: 60 }],
      open_booking: true,
    });
    expect(saved.status).toBe(200);
    expect((await stateOf(organization.id)).publicStatus).toBe("published");
  });

  test("is the owner's alone", async () => {
    const { owner, organization, manicureId } = await register("opening-roles@studio.example");
    for (const role of ["manager", "master", "analyst"] as const) {
      const member = await inviteMember(owner, `opening-${role}@studio.example`, role);
      const refused = await confirm(member, {
        services: [{ id: manicureId, price_minor: 1, duration_minutes: 60 }],
        open_booking: true,
      });
      expect(refused.status).toBe(403);
    }
    expect((await stateOf(organization.id)).publicStatus).toBe("draft");
  });

  test("refuses another studio's service", async () => {
    const first = await register("opening-mine@studio.example");
    const second = await register("opening-theirs@studio.example");
    const refused = await confirm(first.owner, {
      services: [{ id: second.manicureId, price_minor: 1_000, duration_minutes: 60 }],
    });
    expect(refused.status).toBe(404);
    expect(errorCodeOf(refused)).toBe("SERVICE_NOT_FOUND");
  });

  test("will not open a page the deployment does not offer", async () => {
    const { owner, organization, manicureId } = await register("opening-flag@studio.example");
    process.env.PUBLIC_BOOKING_ENABLED = "false";
    try {
      const refused = await confirm(owner, {
        services: [{ id: manicureId, price_minor: 20_000, duration_minutes: 60 }],
        open_booking: true,
      });
      expect(refused.status).toBe(409);
      expect(errorCodeOf(refused)).toBe("PUBLIC_BOOKING_UNAVAILABLE");
    } finally {
      process.env.PUBLIC_BOOKING_ENABLED = "true";
    }
    expect((await stateOf(organization.id)).setupConfirmedAt).toBeNull();
  });
});
