import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  bookingAccessTokens,
  bookingVerifications,
  clients,
  notificationOutbox,
  organizations,
  pilotProductEvents,
} from "@/db/schema";
import { anonymous, dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

type Slot = {
  starts_at: string;
  ends_at: string;
  specialist_id: string;
  specialist_name: string;
};

describe("public online booking", () => {
  let studio: Studio;
  let locationId: string;
  let manageToken: string;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("public-owner@studio.example", "Green Nails");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "green-nails" });
    // Section 7.11: the public page exists for a tenant only after the operator
    // raises its rollout level. Everything below is what that unlocks.
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "centru",
        address: "str. Ismail 33",
        timezone: "Europe/Chisinau",
      }),
    ).id;
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      effective_from: "2026-08-01",
      intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
    });
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
      max_advance_days: 90,
    });
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    await closeTestConnections();
  });

  /** Hold and confirm one offered slot, the way the public form does. */
  async function createBookingAt(slot: Slot) {
    const held = dataOf<{ hold_token: string }>(
      await anonymous.post("/api/v1/public/booking/green-nails/holds", {
        location_id: locationId,
        service_id: studio.serviceId,
        add_on_ids: [],
        specialist_id: slot.specialist_id,
        starts_at: slot.starts_at,
      }),
    );

    return dataOf<{ id: string; manage_token: string; status: string }>(
      await anonymous.post(
        "/api/v1/public/booking/green-nails/bookings",
        {
          hold_token: held.hold_token,
          service_id: studio.serviceId,
          add_on_ids: [],
          name: "Анна",
          phone: "+373 69 123 456",
          email: null,
          locale: "ru",
          legal_accepted: true,
        },
        { "idempotency-key": `create-${crypto.randomUUID()}` },
      ),
    );
  }

  test("profile and catalogue expose only the published booking DTO", async () => {
    const profile = dataOf<{
      name: string;
      notification_channel: string;
      locations: { id: string }[];
    }>(
      await anonymous.get("/api/v1/public/booking/green-nails"),
    );
    expect(profile.name).toBe("Green Nails");
    expect(profile.notification_channel).toBe("sms");
    expect(profile.locations).toEqual([expect.objectContaining({ id: locationId })]);

    const catalog = dataOf<{ services: { id: string; name: string; price_minor: number }[] }>(
      await anonymous.get(`/api/v1/public/booking/green-nails/catalog?location_id=${locationId}`),
    );
    expect(catalog.services).toEqual([
      expect.objectContaining({ id: studio.serviceId, name: "Маникюр с покрытием", price_minor: 60_000 }),
    ]);
  });

  test("a client finds a slot, holds it and creates an idempotent booking", async () => {
    const availability = dataOf<{ slots: Slot[] }>(
      await anonymous.get(
        `/api/v1/public/booking/green-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=2026-09-02`,
      ),
    );
    expect(availability.slots.length).toBeGreaterThan(0);
    const slot = availability.slots[0];

    const held = dataOf<{ hold_token: string; expires_at: string }>(
      await anonymous.post("/api/v1/public/booking/green-nails/holds", {
        location_id: locationId,
        service_id: studio.serviceId,
        add_on_ids: [],
        specialist_id: slot.specialist_id,
        starts_at: slot.starts_at,
      }),
    );
    expect(held.hold_token).toContain(studio.organizationId);

    const key = `public-${crypto.randomUUID()}`;
    const created = dataOf<{ id: string; status: string; manage_token: string; manage_url: string }>(
      await anonymous.post(
        "/api/v1/public/booking/green-nails/bookings",
        {
          hold_token: held.hold_token,
          service_id: studio.serviceId,
          add_on_ids: [],
          name: "Анна",
          phone: "+373 69 123 456",
          email: null,
          locale: "ru",
          legal_accepted: true,
        },
        { "idempotency-key": key },
      ),
    );
    expect(created.status).toBe("confirmed");
    expect(created.manage_url).toBe(`/booking/${created.manage_token}`);
    manageToken = created.manage_token;

    const [client] = await adminDb.select().from(clients).where(eq(clients.organizationId, studio.organizationId));
    expect(client).toMatchObject({
      normalizedPhone: "+37369123456",
      termsVersion: expect.any(String),
      privacyVersion: expect.any(String),
      consentedAt: expect.any(Date),
    });
    const [stored] = await adminDb
      .select()
      .from(bookingAccessTokens)
      .where(eq(bookingAccessTokens.bookingId, created.id));
    expect(stored.tokenHash).not.toContain(manageToken);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("the manage link can reschedule and then cancel the booking", async () => {
    const current = dataOf<{ version: number; status: string }>(
      await anonymous.get(`/api/v1/public/bookings/${manageToken}`),
    );
    expect(current.status).toBe("confirmed");

    const available = dataOf<{ slots: Slot[] }>(
      await anonymous.get(
        `/api/v1/public/booking/green-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=2026-09-09`,
      ),
    );
    const destination = available.slots[0];
    const moveKey = `move-${crypto.randomUUID()}`;
    const moveBody = {
      starts_at: destination.starts_at,
      specialist_id: destination.specialist_id,
      version: current.version,
    };
    const moved = dataOf<{ version: number; starts_at: string }>(
      await anonymous.post(
        `/api/v1/public/bookings/${manageToken}/reschedule`,
        moveBody,
        { "idempotency-key": moveKey },
      ),
    );
    expect(new Date(moved.starts_at).toISOString()).toBe(destination.starts_at);

    const replay = dataOf<{ version: number; replayed: boolean }>(
      await anonymous.post(
        `/api/v1/public/bookings/${manageToken}/reschedule`,
        moveBody,
        { "idempotency-key": moveKey },
      ),
    );
    expect(replay).toMatchObject({ version: moved.version, replayed: true });

    const cancelled = dataOf<{ version: number; status: string }>(
      await anonymous.post(`/api/v1/public/bookings/${manageToken}/cancel`, {
        version: moved.version,
      }),
    );
    expect(cancelled.status).toBe("cancelled");

    const visibleAfterCancel = dataOf<{ status: string }>(
      await anonymous.get(`/api/v1/public/bookings/${manageToken}`),
    );
    expect(visibleAfterCancel.status).toBe("cancelled");

    const queued = await adminDb
      .select({ template: notificationOutbox.template })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, studio.organizationId));
    // The reminder that was queued on creation left with the cancellation:
    // nobody is coming, so nobody is reminded.
    expect(queued.map((row) => row.template).sort()).toEqual([
      "booking.cancelled",
      "booking.confirmed",
      "booking.rescheduled",
    ]);
  });

  test("a confirmed booking is queued a reminder for the day before", async () => {
    const availability = dataOf<{ slots: Slot[] }>(
      await anonymous.get(
        `/api/v1/public/booking/green-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=2026-09-16`,
      ),
    );
    const slot = availability.slots[0];
    const created = await createBookingAt(slot);

    const [reminder] = await adminDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.bookingId, created.id),
          eq(notificationOutbox.template, "booking.reminder"),
        ),
      );

    expect(reminder.status).toBe("pending");
    expect(new Date(reminder.scheduledAt).toISOString()).toBe(
      new Date(new Date(slot.starts_at).getTime() - 24 * 60 * 60_000).toISOString(),
    );
  });

  test("a client may move an appointment within its own hour", async () => {
    const availability = dataOf<{ slots: Slot[] }>(
      await anonymous.get(
        `/api/v1/public/booking/green-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=2026-09-23`,
      ),
    );
    const created = await createBookingAt(availability.slots[0]);

    // The appointment occupies its own hour and a half, so every start time
    // inside it overlaps the booking being moved. Counting that as busy would
    // hide exactly the small shifts a client actually asks for.
    const current = dataOf<{ version: number }>(
      await anonymous.get(`/api/v1/public/bookings/${created.manage_token}`),
    );
    const fifteenLater = new Date(
      new Date(availability.slots[0].starts_at).getTime() + 15 * 60_000,
    ).toISOString();

    const moved = dataOf<{ starts_at: string }>(
      await anonymous.post(
        `/api/v1/public/bookings/${created.manage_token}/reschedule`,
        {
          starts_at: fifteenLater,
          specialist_id: availability.slots[0].specialist_id,
          version: current.version,
        },
        { "idempotency-key": `shift-${crypto.randomUUID()}` },
      ),
    );

    expect(new Date(moved.starts_at).toISOString()).toBe(fifteenLater);
  });

  test("one visit produces one walk through the funnel", async () => {
    const visit = crypto.randomUUID();
    const session = { "x-booking-session": visit };
    const date = "2026-10-14";

    async function eventsOfVisit() {
      const rows = await adminDb
        .select({ name: pilotProductEvents.eventName })
        .from(pilotProductEvents)
        .where(eq(pilotProductEvents.sessionKey, visit));
      return rows.map((row) => row.name).sort();
    }

    await anonymous.get(
      `/api/v1/public/booking/green-nails/catalog?location_id=${locationId}`,
      session,
    );
    // Section 7.10 counts visits: opening the page twice is one visit, and the
    // dedupe key is what makes that true rather than a convention.
    await anonymous.get(
      `/api/v1/public/booking/green-nails/catalog?location_id=${locationId}`,
      session,
    );
    expect(await eventsOfVisit()).toEqual(["booking_page_viewed"]);

    const availability = dataOf<{ slots: Slot[] }>(
      await anonymous.get(
        `/api/v1/public/booking/green-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${date}`,
        session,
      ),
    );
    const held = dataOf<{ hold_token: string }>(
      await anonymous.post(
        "/api/v1/public/booking/green-nails/holds",
        {
          location_id: locationId,
          service_id: studio.serviceId,
          add_on_ids: [],
          specialist_id: availability.slots[0].specialist_id,
          starts_at: availability.slots[0].starts_at,
        },
        session,
      ),
    );
    await anonymous.post(
      "/api/v1/public/booking/green-nails/bookings",
      {
        hold_token: held.hold_token,
        service_id: studio.serviceId,
        add_on_ids: [],
        name: "Дарья",
        phone: "+373 69 616 161",
        email: null,
        locale: "ru",
        legal_accepted: true,
      },
      { ...session, "idempotency-key": `funnel-${crypto.randomUUID()}` },
    );

    expect(await eventsOfVisit()).toEqual([
      "booking_availability_searched",
      "booking_confirmed",
      "booking_page_viewed",
      "booking_service_selected",
      "booking_slot_held",
      "booking_started",
    ]);

    // A caller with no visit key is not a visit. It still books; it simply does
    // not appear in a funnel that counts people who opened the page.
    await anonymous.get(`/api/v1/public/booking/green-nails/catalog?location_id=${locationId}`);
    const anonymousViews = await adminDb
      .select({ name: pilotProductEvents.eventName })
      .from(pilotProductEvents)
      .where(
        and(
          eq(pilotProductEvents.eventName, "booking_page_viewed"),
          eq(pilotProductEvents.sessionKey, ""),
        ),
      );
    expect(anonymousViews).toEqual([]);
  });

  describe("with contact verification switched on", () => {
    let holdToken: string;
    let slot: Slot;

    beforeAll(async () => {
      await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
        verification_mode: "code",
        verification_ttl_minutes: 10,
      });
    });

    afterAll(async () => {
      await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
        verification_mode: "off",
      });
    });

    async function holdOne(date: string) {
      const availability = dataOf<{ slots: Slot[] }>(
        await anonymous.get(
          `/api/v1/public/booking/green-nails/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${date}`,
        ),
      );
      slot = availability.slots[0];
      const held = dataOf<{ hold_token: string }>(
        await anonymous.post("/api/v1/public/booking/green-nails/holds", {
          location_id: locationId,
          service_id: studio.serviceId,
          add_on_ids: [],
          specialist_id: slot.specialist_id,
          starts_at: slot.starts_at,
        }),
      );
      holdToken = held.hold_token;
    }

    function createWith(body: Record<string, unknown>) {
      return anonymous.post(
        "/api/v1/public/booking/green-nails/bookings",
        {
          hold_token: holdToken,
          service_id: studio.serviceId,
          add_on_ids: [],
          name: "Мария",
          phone: "+373 69 555 777",
          email: null,
          locale: "ru",
          legal_accepted: true,
          ...body,
        },
        { "idempotency-key": `verified-${crypto.randomUUID()}` },
      );
    }

    test("an unverified contact cannot create a booking", async () => {
      await holdOne("2026-09-30");
      const refused = await createWith({});

      expect(refused.status).toBe(403);
      expect(errorCodeOf(refused)).toBe("VERIFICATION_REQUIRED");
    });

    test("the code is sent through the outbox and never stored in the clear", async () => {
      const requested = await anonymous.post("/api/v1/public/booking/green-nails/verify", {
        action: "request",
        hold_token: holdToken,
        phone: "+373 69 555 777",
        email: null,
        locale: "ru",
      });
      expect(requested.status).toBe(202);

      const [queued] = await adminDb
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.template, "booking.verification_code"));
      expect(queued.bookingId).toBeNull();
      expect(queued.verificationId).not.toBeNull();

      const [challenge] = await adminDb
        .select()
        .from(bookingVerifications)
        .where(eq(bookingVerifications.id, queued.verificationId!));
      const code = queued.payload!.code!;
      expect(challenge.codeHash).not.toContain(code);
      expect(challenge.destination).toBe("+37369555777");

      const wrong = await anonymous.post("/api/v1/public/booking/green-nails/verify", {
        action: "confirm",
        hold_token: holdToken,
        code: code === "000000" ? "999999" : "000000",
      });
      expect(errorCodeOf(wrong)).toBe("VERIFICATION_FAILED");

      const right = await anonymous.post("/api/v1/public/booking/green-nails/verify", {
        action: "confirm",
        hold_token: holdToken,
        code,
      });
      expect(right.status).toBe(200);

      const created = dataOf<{ status: string }>(await createWith({}));
      expect(created.status).toBe("confirmed");
    });

    test("a code confirmed for one number does not book another", async () => {
      await holdOne("2026-10-07");
      const requested = await anonymous.post("/api/v1/public/booking/green-nails/verify", {
        action: "request",
        hold_token: holdToken,
        phone: "+373 69 555 777",
        email: null,
        locale: "ru",
      });
      expect(requested.status).toBe(202);

      const [queued] = await adminDb
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.template, "booking.verification_code"),
            eq(notificationOutbox.status, "pending"),
          ),
        )
        .orderBy(desc(notificationOutbox.createdAt))
        .limit(1);

      await anonymous.post("/api/v1/public/booking/green-nails/verify", {
        action: "confirm",
        hold_token: holdToken,
        code: queued.payload!.code!,
      });

      // Section 7.9: verification binds a contact, not merely a session.
      const refused = await createWith({ phone: "+373 69 111 222" });
      expect(errorCodeOf(refused)).toBe("VERIFICATION_REQUIRED");
    });

    test("Resend verifies email; the booking itself still reaches every channel the client left", async () => {
      process.env.NOTIFICATION_PROVIDER = "resend";
      try {
        await holdOne("2026-10-14");
        const requested = await anonymous.post("/api/v1/public/booking/green-nails/verify", {
          action: "request",
          hold_token: holdToken,
          phone: "+373 69 555 777",
          email: "maria@example.com",
          locale: "ru",
        });
        expect(requested.status).toBe(202);
        expect(dataOf<{ channel: string }>(requested).channel).toBe("email");

        const [queued] = await adminDb
          .select()
          .from(notificationOutbox)
          .where(
            and(
              eq(notificationOutbox.template, "booking.verification_code"),
              eq(notificationOutbox.status, "pending"),
            ),
          )
          .orderBy(desc(notificationOutbox.createdAt))
          .limit(1);
        expect(queued.channel).toBe("email");

        const [challenge] = await adminDb
          .select()
          .from(bookingVerifications)
          .where(eq(bookingVerifications.id, queued.verificationId!));
        expect(challenge.destination).toBe("maria@example.com");

        await anonymous.post("/api/v1/public/booking/green-nails/verify", {
          action: "confirm",
          hold_token: holdToken,
          code: queued.payload!.code!,
        });
        const created = dataOf<{ id: string; status: string }>(
          await createWith({ email: "maria@example.com" }),
        );
        expect(created.status).toBe("confirmed");

        // Verification picked one channel (email, since NOTIFICATION_PROVIDER
        // is resend) — but the client also left a phone number, and every
        // `notifyBooking` call (confirmation, then the reminder queued right
        // behind it) reaches every channel the client can be reached on,
        // independent of which provider answers for email. Two calls, two
        // channels each.
        const rows = await adminDb
          .select({ channel: notificationOutbox.channel })
          .from(notificationOutbox)
          .where(eq(notificationOutbox.bookingId, created.id));
        expect(rows.map((row) => row.channel).sort()).toEqual(["email", "email", "sms", "sms"]);
      } finally {
        delete process.env.NOTIFICATION_PROVIDER;
      }
    });
  });
});
