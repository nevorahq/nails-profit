import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { notificationOutbox, organizations, organizationSubscriptions, pilotEnrollments } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadOrganizationPlan } from "@/lib/plan";
import { publicSpecialistsFor } from "@/lib/public-booking";
import { paddlePlanPrices } from "@/lib/paddle-catalog";
import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The tariff limits of `domain/plans.ts`, through the routes a studio uses.
 *
 * A new studio gets fourteen days of «Студия» and then «Старт» for as long as
 * it does not pay: one master taking appointments, this month's report, email
 * only, and the paid features refused with 402 and the tier that opens them.
 * Nothing it made during the trial is taken away — a second master stays on
 * file, and simply takes no new appointments.
 */
/** Puts an environment variable back as it was — unset stays unset, not "undefined". */
function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("tariff limits", () => {
  let studio: Studio;
  let secondId: string;
  let locationId: string;
  let slot = 0;
  const previous = {
    enforcement: process.env.PLAN_LIMITS_ENFORCEMENT,
    environment: process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT,
  };

  function nextSlot() {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7 + slot);
    day.setUTCHours(8 + (slot++ % 6));
    return day.toISOString();
  }

  /** The studio as if it had signed up `days` ago. */
  async function signedUpDaysAgo(days: number) {
    await adminDb
      .update(organizations)
      .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
      .where(eq(organizations.id, studio.organizationId));
  }

  async function planNow() {
    return withTenant(studio.organizationId, (tx) => loadOrganizationPlan(tx, studio.organizationId));
  }

  beforeAll(async () => {
    process.env.PLAN_LIMITS_ENFORCEMENT = "true";
    process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT = "sandbox";
    await resetDatabase();
    studio = await createCanonicalStudio("plan-owner@studio.example", "Plan Studio");
    // Registration gives the studio its one address; the trial's «Студия» has
    // room for no other.
    locationId = dataOf<{ id: string }[]>(await studio.owner.get("/api/v1/locations"))[0].id;
  });

  beforeEach(() => {
    process.env.PLAN_LIMITS_ENFORCEMENT = "true";
  });

  afterEach(async () => {
    await adminDb.delete(organizationSubscriptions).where(eq(organizationSubscriptions.organizationId, studio.organizationId));
    await adminDb.delete(pilotEnrollments).where(eq(pilotEnrollments.organizationId, studio.organizationId));
  });

  afterAll(async () => {
    restoreEnv("PLAN_LIMITS_ENFORCEMENT", previous.enforcement);
    restoreEnv("NEXT_PUBLIC_PADDLE_ENVIRONMENT", previous.environment);
    await closeTestConnections();
  });

  test("a new studio is on a Studio trial and may build its team", async () => {
    expect(await planNow()).toMatchObject({ tier: "studio", source: "trial" });

    const created = await studio.owner.post("/api/v1/specialists", {
      name: "Вторая",
      default_rule: { type: "percentage", basis_points: 4000 },
    });
    expect(created.status).toBeLessThan(300);
    secondId = dataOf<{ id: string }>(created).id;
  });

  describe("past the trial, without paying", () => {
    beforeEach(async () => {
      await signedUpDaysAgo(15);
    });

    test("is on Start", async () => {
      expect(await planNow()).toEqual({ tier: "start", source: "free", trialEndsAt: null });
    });

    test("cannot add a master, a second address, a colleague, an expense or an import", async () => {
      const master = await studio.owner.post("/api/v1/specialists", {
        name: "Третья",
        default_rule: { type: "percentage", basis_points: 4000 },
      });
      expect(master.status).toBe(402);
      expect(errorCodeOf(master)).toBe("PLAN_SPECIALIST_LIMIT");

      const address = await studio.owner.post("/api/v1/locations", { name: "Ботаника", slug: "plan-botanica" });
      expect(address.status).toBe(402);
      expect(errorCodeOf(address)).toBe("PLAN_LOCATION_LIMIT");

      const invitation = await studio.owner.post("/api/v1/invitations", {
        email: "colleague@studio.example",
        role: "manager",
      });
      expect(invitation.status).toBe(402);
      expect(invitation.body).toMatchObject({
        error: { code: "PLAN_UPGRADE_REQUIRED", details: { feature: "team", tier: "studio" } },
      });

      const expense = await studio.owner.post("/api/v1/expenses", {
        name: "Аренда",
        category: "rent",
        amount_minor: 500_000,
        spent_on: new Date().toISOString().slice(0, 10),
      });
      expect(expense.status).toBe(402);
      expect(expense.body).toMatchObject({ error: { details: { feature: "expenses", tier: "solo" } } });

      const upload = new FormData();
      upload.set("entity", "service");
      upload.set("file", new File(["name,price\nПедикюр,500\n"], "services.csv", { type: "text/csv" }));
      const imported = await studio.owner.post("/api/v1/imports", upload);
      expect(imported.status).toBe(402);
    });

    test("keeps the trial's second master on file but books only the first", async () => {
      const first = await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: studio.specialistId,
        actual_duration_minutes: 90,
      });
      expect(first.status).toBeLessThan(300);

      const second = await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: secondId,
        actual_duration_minutes: 90,
      });
      expect(second.status).toBe(402);
      expect(errorCodeOf(second)).toBe("PLAN_SPECIALIST_LIMIT");

      const booking = await studio.owner.post(
        "/api/v1/bookings",
        { location_id: locationId, specialist_id: secondId, service_id: studio.serviceId, starts_at: nextSlot() },
        { "idempotency-key": `plan-${crypto.randomUUID()}` },
      );
      expect(booking.status).toBe(402);

      const cards = dataOf<{ id: string }[]>(await studio.owner.get("/api/v1/specialists"));
      expect(cards.map((card) => card.id)).toContain(secondId);

      // The public page offers only the master who can take the appointment.
      const offered = await withTenant(studio.organizationId, (tx) =>
        publicSpecialistsFor(tx, locationId, studio.serviceId),
      );
      expect(offered.map((person) => person.id)).toEqual([studio.specialistId]);
    });

    test("reminds clients by email only", async () => {
      const client = dataOf<{ id: string }>(
        await studio.owner.post("/api/v1/clients", {
          name: "Ольга",
          phone: "+373 69 111 333",
          email: "olga@client.example",
        }),
      );
      const booking = dataOf<{ id: string }>(
        await studio.owner.post(
          "/api/v1/bookings",
          {
            location_id: locationId,
            specialist_id: studio.specialistId,
            service_id: studio.serviceId,
            client_id: client.id,
            starts_at: nextSlot(),
          },
          { "idempotency-key": `plan-${crypto.randomUUID()}` },
        ),
      );

      const queued = await adminDb
        .select({ channel: notificationOutbox.channel })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.bookingId, booking.id));
      expect(queued.length).toBeGreaterThan(0);
      expect(queued.every((row) => row.channel === "email")).toBe(true);
    });

    test("works as before while the limits are switched off", async () => {
      process.env.PLAN_LIMITS_ENFORCEMENT = "false";
      const offered = await withTenant(studio.organizationId, (tx) =>
        publicSpecialistsFor(tx, locationId, studio.serviceId),
      );
      expect(offered.map((person) => person.id).sort()).toEqual([studio.specialistId, secondId].sort());

      const expense = await studio.owner.post("/api/v1/expenses", {
        name: "Аренда",
        category: "rent",
        amount_minor: 500_000,
        spent_on: new Date().toISOString().slice(0, 10),
      });
      expect(expense.status).toBeLessThan(300);
    });
  });

  describe("past the trial, with a reason to be on more than Start", () => {
    beforeEach(async () => {
      await signedUpDaysAgo(60);
    });

    test("a pilot studio is on Studio and may invite its team", async () => {
      await adminDb.insert(pilotEnrollments).values({
        organizationId: studio.organizationId,
        wave: "design_partner",
        status: "active",
        operatorRef: "plan-limits-test",
      });
      expect(await planNow()).toMatchObject({ tier: "studio", source: "pilot" });

      const invitation = await studio.owner.post("/api/v1/invitations", {
        email: "pilot-colleague@studio.example",
        role: "manager",
      });
      expect(invitation.status).toBeLessThan(300);
    });

    test("a pilot studio past its free Studio is on Start like everyone else", async () => {
      await adminDb.insert(pilotEnrollments).values({
        organizationId: studio.organizationId,
        wave: "design_partner",
        status: "active",
        operatorRef: "plan-limits-test",
      });
      const before = process.env.PILOT_FREE_UNTIL;
      process.env.PILOT_FREE_UNTIL = "2026-01-31";
      try {
        expect(await planNow()).toMatchObject({ tier: "start", source: "free" });
        const invitation = await studio.owner.post("/api/v1/invitations", {
          email: "late-pilot-colleague@studio.example",
          role: "manager",
        });
        expect(invitation.status).toBe(402);
      } finally {
        restoreEnv("PILOT_FREE_UNTIL", before);
      }
    });

    test("a Solo subscription opens expenses but not the team", async () => {
      await adminDb.insert(organizationSubscriptions).values({
        organizationId: studio.organizationId,
        provider: "paddle",
        providerCustomerId: "ctm_plan_limits_test",
        providerSubscriptionId: "sub_plan_limits_test",
        providerPriceId: paddlePlanPrices("sandbox")!.solo[12],
        status: "active",
      });
      expect(await planNow()).toEqual({ tier: "solo", source: "subscription", trialEndsAt: null });

      const expense = await studio.owner.post("/api/v1/expenses", {
        name: "Лампа",
        category: "tools",
        amount_minor: 120_000,
        spent_on: new Date().toISOString().slice(0, 10),
      });
      expect(expense.status).toBeLessThan(300);

      const invitation = await studio.owner.post("/api/v1/invitations", {
        email: "solo-colleague@studio.example",
        role: "manager",
      });
      expect(invitation.status).toBe(402);
    });

    test("a canceled subscription falls back to Start", async () => {
      await adminDb.insert(organizationSubscriptions).values({
        organizationId: studio.organizationId,
        provider: "paddle",
        providerCustomerId: "ctm_plan_limits_test",
        providerSubscriptionId: "sub_plan_limits_canceled",
        providerPriceId: paddlePlanPrices("sandbox")!.business[1],
        status: "canceled",
      });
      expect(await planNow()).toMatchObject({ tier: "start", source: "free" });
    });
  });
});
