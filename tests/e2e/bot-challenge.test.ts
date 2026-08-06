import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { organizations } from "@/db/schema";
import { solveChallenge } from "@/domain/proof-of-work";
import { resetBotChallenges } from "@/lib/bot-challenge";
import { anonymous, dataOf, errorCodeOf, type ApiResponse } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The bot challenge of roadmap section 7.9: "после порога подозрительной
 * активности включается bot challenge".
 *
 * The threshold is the interesting part. A client who books an appointment must
 * never meet this, so the suite first books one and only then starts behaving
 * like a script — from a different address, because the whole mechanism is
 * per caller.
 */
type Challenge = { nonce: string; difficulty_bits: number };

describe("bot challenge", () => {
  let studio: Studio;
  let locationId: string;
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

  /** A hold request for a time that was never offered: cheap, and always refused. */
  function pointlessHold(ip: string, headers: Record<string, string> = {}) {
    return anonymous.post(
      "/api/v1/public/booking/challenge-studio/holds",
      {
        location_id: locationId,
        service_id: studio.serviceId,
        add_on_ids: [],
        specialist_id: studio.specialistId,
        starts_at: new Date("2027-01-04T02:00:00.000Z").toISOString(),
      },
      { ...from(ip), ...headers },
    );
  }

  function challengeOf(response: ApiResponse<unknown>): Challenge {
    const body = response.body as { error: { details: Challenge } };
    return body.error.details;
  }

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    resetBotChallenges();
    studio = await createCanonicalStudio("challenge-owner@studio.example", "Challenge Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "challenge-studio" });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "challenge-centru",
        timezone: "Europe/Chisinau",
      }),
    ).id;
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "07:00", end: "21:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      public_status: "published",
      confirmation_mode: "instant",
      min_lead_minutes: 0,
    });
    await adminDb
      .update(organizations)
      .set({ bookingAccess: "public" })
      .where(eq(organizations.id, studio.organizationId));
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED;
    else process.env.PUBLIC_BOOKING_ENABLED = previousFlag;
    resetBotChallenges();
    await closeTestConnections();
  });

  test("a client who simply books is never challenged", async () => {
    const caller = from("10.1.0.1");
    const slots = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/challenge-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${nextWednesday().toISOString().slice(0, 10)}`,
        caller,
      ),
    );
    const held = dataOf<{ hold_token: string }>(
      await anonymous.post(
        "/api/v1/public/booking/challenge-studio/holds",
        {
          location_id: locationId,
          service_id: studio.serviceId,
          add_on_ids: [],
          specialist_id: slots.slots[0].specialist_id,
          starts_at: slots.slots[0].starts_at,
        },
        caller,
      ),
    );

    const created = await anonymous.post(
      "/api/v1/public/booking/challenge-studio/bookings",
      {
        hold_token: held.hold_token,
        service_id: studio.serviceId,
        add_on_ids: [],
        name: "Полина",
        phone: "+373 69 313 131",
        email: null,
        locale: "ru",
        legal_accepted: true,
      },
      { ...caller, "idempotency-key": `clean-${crypto.randomUUID()}` },
    );

    expect(created.status).toBe(201);
  });

  test("a caller that keeps being refused is asked to do the work", async () => {
    const ip = "10.1.0.2";
    let challenged: ApiResponse<unknown> | null = null;

    for (let attempt = 0; attempt < 15 && !challenged; attempt += 1) {
      const response = await pointlessHold(ip);
      if (response.status === 403) challenged = response;
      else expect(errorCodeOf(response)).toBe("SLOT_UNAVAILABLE");
    }

    expect(challenged).not.toBeNull();
    expect(errorCodeOf(challenged!)).toBe("CHALLENGE_REQUIRED");

    const challenge = challengeOf(challenged!);
    expect(challenge.difficulty_bits).toBe(16);

    // The work lets the same caller back in — and the answer is the ordinary
    // refusal again, because the challenge was never about this request being
    // wrong.
    const solution = solveChallenge(challenge.nonce, challenge.difficulty_bits);
    const solved = await pointlessHold(ip, {
      "x-booking-challenge": `${challenge.nonce}:${solution}`,
    });
    expect(errorCodeOf(solved)).toBe("SLOT_UNAVAILABLE");

    // One nonce, one request: replaying it is refused, so the cost is paid per
    // attempt rather than once per attacker.
    const replayed = await pointlessHold(ip, {
      "x-booking-challenge": `${challenge.nonce}:${solution}`,
    });
    expect(errorCodeOf(replayed)).toBe("CHALLENGE_REQUIRED");
    expect(challengeOf(replayed).nonce).not.toBe(challenge.nonce);
  });

  test("a wrong solution, a forged nonce and someone else's challenge are all refused", async () => {
    const ip = "10.1.0.3";
    let challenged: ApiResponse<unknown> | null = null;
    for (let attempt = 0; attempt < 15 && !challenged; attempt += 1) {
      const response = await pointlessHold(ip);
      if (response.status === 403) challenged = response;
    }
    const challenge = challengeOf(challenged!);

    const wrong = await pointlessHold(ip, { "x-booking-challenge": `${challenge.nonce}:0` });
    expect(errorCodeOf(wrong)).toBe("CHALLENGE_REQUIRED");
    expect((wrong.body as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "unsolved",
    );

    const [expiry, random] = challenge.nonce.split(".");
    const forged = `${expiry}.${random}.not-a-signature`;
    const tampered = await pointlessHold(ip, {
      "x-booking-challenge": `${forged}:${solveChallenge(forged, 16)}`,
    });
    expect((tampered.body as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "invalid",
    );

    // The nonce is signed for one caller: a solved challenge cannot be handed
    // to a second address to spend.
    const borrowed = await pointlessHold("10.1.0.4", {
      "x-booking-challenge": `${challenge.nonce}:${solveChallenge(challenge.nonce, 16)}`,
    });
    expect(errorCodeOf(borrowed)).toBe("SLOT_UNAVAILABLE");
  });

  test("reading stays free", async () => {
    const ip = "10.1.0.5";
    for (let attempt = 0; attempt < 12; attempt += 1) await pointlessHold(ip);

    // A visitor comparing times is never asked to compute anything: the rate
    // limits already bound what reads cost.
    const page = await anonymous.get("/api/v1/public/booking/challenge-studio", from(ip));
    expect(page.status).toBe(200);
    const availability = await anonymous.get(
      `/api/v1/public/booking/challenge-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${nextWednesday(3).toISOString().slice(0, 10)}`,
      from(ip),
    );
    expect(availability.status).toBe(200);
  });
});
