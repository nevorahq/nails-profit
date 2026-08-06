import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, bookingAccessTokens, organizations } from "@/db/schema";
import { anonymous, dataOf, errorCodeOf, type ApiResponse } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The security matrix of roadmap sections 7.9 and 7.12: token abuse,
 * enumeration, cross-tenant identifiers, rate limits and CSRF.
 *
 * Every case here is a claim the phase makes about what an attacker cannot
 * learn or do, and each is checked from outside the process, at the endpoint,
 * because that is where the claim has to hold.
 *
 * Callers are separated by `x-forwarded-for`: the rate limiter keys on it, and
 * a test that spent another test's budget would fail for the wrong reason.
 */
type Slot = { starts_at: string; specialist_id: string };

describe("booking security", () => {
  let studio: Studio;
  let other: Studio;
  let locationId: string;
  let otherLocationId: string;
  let manageToken: string;
  let holdToken: string;
  let bookingId: string;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  function from(ip: string) {
    return { "x-forwarded-for": ip };
  }

  function nextWednesday(weeksAhead = 1) {
    const day = new Date();
    day.setUTCHours(9, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7 * weeksAhead);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    return day;
  }

  async function publish(target: Studio, slug: string, locationSlug: string) {
    await target.owner.patch("/api/v1/organizations/settings", { slug });
    const id = dataOf<{ id: string }>(
      await target.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: locationSlug,
        timezone: "Europe/Chisinau",
      }),
    ).id;
    await target.owner.put(`/api/v1/specialists/${target.specialistId}/locations`, {
      location_ids: [id],
    });
    await target.owner.put("/api/v1/availability/rules", {
      specialist_id: target.specialistId,
      location_id: id,
      intervals: [{ weekday: 3, start: "07:00", end: "21:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });
    await target.owner.put(`/api/v1/locations/${id}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
    });
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, target.organizationId));
    return id;
  }

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("security-owner@studio.example", "Secure Nails");
    other = await createCanonicalStudio("security-other@studio.example", "Other Nails");
    locationId = await publish(studio, "secure-nails", "secure-centru");
    otherLocationId = await publish(other, "other-nails", "other-centru");

    const slots = dataOf<{ slots: Slot[] }>(
      await anonymous.get(
        `/api/v1/public/booking/secure-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${nextWednesday().toISOString().slice(0, 10)}`,
        from("10.0.0.1"),
      ),
    );
    const held = dataOf<{ hold_token: string }>(
      await anonymous.post(
        "/api/v1/public/booking/secure-nails/holds",
        {
          location_id: locationId,
          service_id: studio.serviceId,
          add_on_ids: [],
          specialist_id: slots.slots[0].specialist_id,
          starts_at: slots.slots[0].starts_at,
        },
        from("10.0.0.1"),
      ),
    );
    holdToken = held.hold_token;

    const created = dataOf<{ id: string; manage_token: string }>(
      await anonymous.post(
        "/api/v1/public/booking/secure-nails/bookings",
        {
          hold_token: holdToken,
          service_id: studio.serviceId,
          add_on_ids: [],
          name: "Ирина",
          phone: "+373 69 909 090",
          email: "irina@example.com",
          locale: "ru",
          legal_accepted: true,
        },
        { ...from("10.0.0.1"), "idempotency-key": `security-${crypto.randomUUID()}` },
      ),
    );
    manageToken = created.manage_token;
    bookingId = created.id;
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    await closeTestConnections();
  });

  describe("access tokens", () => {
    test("a hold token cannot open the booking it created", async () => {
      // Purpose is hashed in with the secret, so the same string means nothing
      // at a different door.
      const opened = await anonymous.get(
        `/api/v1/public/bookings/${holdToken}`,
        from("10.0.1.1"),
      );
      expect(opened.status).toBe(404);
    });

    test("a tampered organization prefix does not authenticate", async () => {
      const [, secret] = manageToken.split(".");
      const forged = `${other.organizationId}.${secret}`;
      expect((await anonymous.get(`/api/v1/public/bookings/${forged}`, from("10.0.1.2"))).status).toBe(404);
    });

    test("a tampered secret does not authenticate", async () => {
      const [organizationId] = manageToken.split(".");
      const forged = `${organizationId}.${"a".repeat(43)}`;
      expect((await anonymous.get(`/api/v1/public/bookings/${forged}`, from("10.0.1.3"))).status).toBe(404);
    });

    test("an expired token stops working, and so does a revoked one", async () => {
      const [live] = await adminDb
        .select()
        .from(bookingAccessTokens)
        .where(eq(bookingAccessTokens.bookingId, bookingId));

      await adminDb
        .update(bookingAccessTokens)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(bookingAccessTokens.id, live.id));
      expect((await anonymous.get(`/api/v1/public/bookings/${manageToken}`, from("10.0.1.4"))).status).toBe(404);

      await adminDb
        .update(bookingAccessTokens)
        .set({ expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: new Date() })
        .where(eq(bookingAccessTokens.id, live.id));
      expect((await anonymous.get(`/api/v1/public/bookings/${manageToken}`, from("10.0.1.5"))).status).toBe(404);

      await adminDb
        .update(bookingAccessTokens)
        .set({ revokedAt: null })
        .where(eq(bookingAccessTokens.id, live.id));
      expect((await anonymous.get(`/api/v1/public/bookings/${manageToken}`, from("10.0.1.6"))).status).toBe(200);
    });

    test("a hold from one studio cannot be booked through another's page", async () => {
      const crossed = await anonymous.post(
        "/api/v1/public/booking/other-nails/bookings",
        {
          hold_token: holdToken,
          service_id: other.serviceId,
          add_on_ids: [],
          name: "Ирина",
          phone: "+373 69 909 090",
          email: null,
          locale: "ru",
          legal_accepted: true,
        },
        { ...from("10.0.1.7"), "idempotency-key": `cross-${crypto.randomUUID()}` },
      );
      expect(crossed.status).toBe(404);
    });

    test("a staff member cannot open another studio's booking", async () => {
      const foreign = await other.owner.get(`/api/v1/bookings/${bookingId}`);
      expect(foreign.status).toBe(404);
      expect(errorCodeOf(foreign)).toBe("BOOKING_NOT_FOUND");
    });
  });

  describe("what an outsider can learn", () => {
    function shapeOf(response: ApiResponse<unknown>) {
      return { status: response.status, code: errorCodeOf(response) };
    }

    /** The whole envelope with the one field that legitimately differs removed. */
    function envelopeOf(response: ApiResponse<unknown>) {
      const body = response.body as { error: Record<string, unknown> };
      return JSON.stringify({ ...body, error: { ...body.error, request_id: "<per request>" } });
    }

    test("unknown, unpublished and rolled-back pages answer identically", async () => {
      const unknown = await anonymous.get("/api/v1/public/booking/no-such-studio", from("10.0.2.1"));

      await adminDb
        .update(organizations)
        .set({ bookingAccess: "calendar" })
        .where(eq(organizations.id, other.organizationId));
      const rolledBack = await anonymous.get("/api/v1/public/booking/other-nails", from("10.0.2.2"));

      await other.owner.put(`/api/v1/locations/${otherLocationId}/booking-settings`, {
        public_status: "paused",
      });
      const paused = await anonymous.get("/api/v1/public/booking/other-nails", from("10.0.2.3"));

      // Section 7.9: "draft, paused, unknown and disabled are deliberately
      // indistinguishable" — otherwise the 404 becomes a directory of studios.
      expect(shapeOf(rolledBack)).toEqual(shapeOf(unknown));
      expect(shapeOf(paused)).toEqual(shapeOf(unknown));
      expect(envelopeOf(rolledBack)).toBe(envelopeOf(unknown));
      expect(envelopeOf(paused)).toBe(envelopeOf(unknown));
    });

    test("an unknown manage link looks like an expired one", async () => {
      const unknown = await anonymous.get(
        `/api/v1/public/bookings/${studio.organizationId}.${"b".repeat(43)}`,
        from("10.0.2.4"),
      );
      const malformed = await anonymous.get("/api/v1/public/bookings/not-a-token", from("10.0.2.5"));

      expect(shapeOf(malformed)).toEqual(shapeOf(unknown));
    });

    test("asking for a code says nothing about who already books here", async () => {
      const slots = dataOf<{ slots: Slot[] }>(
        await anonymous.get(
          `/api/v1/public/booking/secure-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${nextWednesday(2).toISOString().slice(0, 10)}`,
          from("10.0.2.6"),
        ),
      );
      const held = dataOf<{ hold_token: string }>(
        await anonymous.post(
          "/api/v1/public/booking/secure-nails/holds",
          {
            location_id: locationId,
            service_id: studio.serviceId,
            add_on_ids: [],
            specialist_id: slots.slots[0].specialist_id,
            starts_at: slots.slots[0].starts_at,
          },
          from("10.0.2.6"),
        ),
      );

      await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
        verification_mode: "code",
      });

      // One number belongs to the client booked in `beforeAll`, the other to
      // nobody. The answers have to be the same shape and the same status.
      const known = await anonymous.post(
        "/api/v1/public/booking/secure-nails/verify",
        {
          action: "request",
          hold_token: held.hold_token,
          phone: "+373 69 909 090",
          email: null,
          locale: "ru",
        },
        from("10.0.2.6"),
      );
      const stranger = await anonymous.post(
        "/api/v1/public/booking/secure-nails/verify",
        {
          action: "request",
          hold_token: held.hold_token,
          phone: "+373 69 111 000",
          email: null,
          locale: "ru",
        },
        from("10.0.2.7"),
      );

      expect(known.status).toBe(202);
      expect(stranger.status).toBe(202);
      expect(Object.keys(dataOf<Record<string, unknown>>(known)).sort()).toEqual(
        Object.keys(dataOf<Record<string, unknown>>(stranger)).sort(),
      );

      await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
        verification_mode: "off",
      });
    });
  });

  describe("rate limits", () => {
    test("each action has its own budget, and a refusal says when to return", async () => {
      const caller = from("10.0.3.1");
      let refusal: ApiResponse<unknown> | null = null;

      // The verification bucket is the smallest; spend it.
      for (let attempt = 0; attempt < 20 && !refusal; attempt += 1) {
        const response = await anonymous.post(
          "/api/v1/public/booking/secure-nails/verify",
          { action: "confirm", hold_token: `${studio.organizationId}.${"c".repeat(43)}`, code: "000000" },
          caller,
        );
        if (response.status === 429) refusal = response;
      }

      expect(refusal).not.toBeNull();
      expect(errorCodeOf(refusal!)).toBe("RATE_LIMITED");
      expect(refusal!.headers?.get("retry-after")).toBeTruthy();

      // Section 7.9 keeps the buckets apart: spending one must not close the
      // page for the same visitor.
      const profile = await anonymous.get("/api/v1/public/booking/secure-nails", caller);
      expect(profile.status).toBe(200);
    });
  });

  describe("cross-site requests", () => {
    test("a session does not count on a request from someone else's page", async () => {
      const forged = await studio.owner.post(
        "/api/v1/clients",
        { name: "Через чужой сайт" },
        { origin: "https://evil.example" },
      );
      expect(forged.status).toBe(401);

      const labelled = await studio.owner.post(
        "/api/v1/clients",
        { name: "Через чужой сайт" },
        { "sec-fetch-site": "cross-site" },
      );
      expect(labelled.status).toBe(401);
    });

    test("the application's own pages are unaffected", async () => {
      const own = await studio.owner.post(
        "/api/v1/clients",
        { name: "Своя страница" },
        { "sec-fetch-site": "same-origin" },
      );
      expect(own.status).toBe(201);
    });
  });

  describe("what is written down", () => {
    test("the audit trail of a public booking carries no contact details", async () => {
      const events = await adminDb
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, studio.organizationId),
            eq(auditEvents.entityType, "booking"),
          ),
        );

      expect(events.length).toBeGreaterThan(0);
      const written = JSON.stringify(events);
      // Section 7.9 keeps PII out of these columns: the booking records that an
      // email was given, never which one.
      expect(written).not.toContain("irina@example.com");
      expect(written).not.toContain("909090");
      expect(written).not.toContain("+37369909090");
      expect(written).toContain("has_email");
    });

    test("no raw token is stored anywhere", async () => {
      const tokens = await adminDb
        .select({ hash: bookingAccessTokens.tokenHash })
        .from(bookingAccessTokens)
        .where(eq(bookingAccessTokens.organizationId, studio.organizationId));

      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(token.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(manageToken).not.toContain(token.hash);
      }
    });
  });
});
