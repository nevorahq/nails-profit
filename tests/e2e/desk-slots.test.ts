import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { localToUtc, parseLocalDate } from "@/domain/timezone";
import { clockAt } from "@/components/calendar-free-time";
import { anonymous, dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { isoDay, weekdayAhead } from "../helpers/calendar";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * The free times the appointment form offers, `GET /api/v1/availability/slots`.
 *
 * The same engine the public page reads, asked for the desk: so these pin what
 * differs (the rota and the booked hours decide, the public lead time does not)
 * and what the form depends on (the sitting's length is the sum of its parts,
 * times are the location's wall clock, a master asks only for their own day).
 */
type Slots = { date: string; timezone: string; duration_minutes: number; slots: string[] };

const ZONE = "Europe/Chisinau";

let studio: Studio;
let master: Actor;
let stranger: Actor;
let analyst: Actor;
let locationId: string;
let pedicureId: string;

/** Next Tuesday, never today: a day that is always ahead of the clock the suite runs on. */
const day = isoDay(weekdayAhead(2, 1));

function query(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    location_id: locationId,
    specialist_id: studio.specialistId,
    date: day,
    services: studio.serviceId,
    ...overrides,
  }).toString();
}

async function slotsFor(overrides: Record<string, string> = {}, actor: Actor = studio.owner) {
  return actor.get<Slots>(`/api/v1/availability/slots?${query(overrides)}`);
}

const clocks = (slots: Slots) => slots.slots.map((slot) => clockAt(slot, ZONE));

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("desk-slots-owner@studio.example", "Desk Slots Studio");
  master = await inviteMember(studio.owner, "desk-slots-master@studio.example", "master");
  // A master with no card of their own: no calendar here is theirs.
  stranger = await inviteMember(studio.owner, "desk-slots-stranger@studio.example", "master");
  analyst = await inviteMember(studio.owner, "desk-slots-analyst@studio.example", "analyst");
  await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

  locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "desk-slots", timezone: ZONE }),
  ).id;
  await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
    location_ids: [locationId],
  });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: studio.specialistId,
    location_id: locationId,
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })),
    effective_from: "2026-08-01",
  });

  // An hourly grid, and a public window of a fortnight: the desk's answer is
  // asserted against both, so neither may be left to a default.
  const settings = await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
    public_status: "draft",
    slot_step_minutes: 60,
    min_lead_minutes: 120,
    max_advance_days: 14,
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
    confirmation_mode: "instant",
    confirmation_ttl_minutes: 120,
    verification_mode: "off",
    verification_ttl_minutes: 10,
    reminder_lead_minutes: 1_440,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);

  pedicureId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/services", {
      name: { ru: "Педикюр" },
      price_minor: 40_000,
      duration_minutes: 60,
    }),
  ).id;
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("the free times of a day", () => {
  test("an empty day offers the whole rota, as the location's wall clock", async () => {
    const response = await slotsFor();
    expect(response.status).toBe(200);

    const answer = dataOf<Slots>(response);
    expect(answer.date).toBe(day);
    expect(answer.timezone).toBe(ZONE);
    expect(answer.duration_minutes).toBe(90);

    const times = clocks(answer);
    // 09:00 to 18:00 holds a 90-minute service starting up to 16:00 on an hourly grid.
    expect(times[0]).toBe("09:00");
    expect(times.at(-1)).toBe("16:00");
    expect(times).toContain("12:00");
  });

  test("an appointment takes its hours out of the day", async () => {
    const parsed = parseLocalDate(day)!;
    const booked = await studio.owner.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        starts_at: localToUtc(parsed, 10 * 60, ZONE).toISOString(),
      },
      { "idempotency-key": `desk-slots-${crypto.randomUUID()}` },
    );
    expect(booked.status).toBe(201);

    const times = clocks(dataOf<Slots>(await slotsFor()));
    // 10:00–11:30 is taken, and a 90-minute service from 09:00 or 11:00 runs into it.
    for (const taken of ["09:00", "10:00", "11:00"]) expect(times).not.toContain(taken);
    // Clear of it, from the first start after it to the last of the day.
    expect(times).toContain("12:00");
    expect(times).toContain("16:00");
  });

  test("several services are one sitting as long as their sum", async () => {
    const answer = dataOf<Slots>(await slotsFor({ services: `${studio.serviceId}|${pedicureId}` }));

    expect(answer.duration_minutes).toBe(150);
    // Ninety and sixty minutes: the last hourly start that still ends by 18:00 is 15:00.
    expect(clocks(answer).at(-1)).toBe("15:00");
  });

  test("a day already gone has nothing to offer", async () => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const answer = dataOf<Slots>(await slotsFor({ date: isoDay(yesterday) }));
    expect(answer.slots).toEqual([]);
  });

  test("a day beyond the public page's advance window is still offered to the desk", async () => {
    const far = new Date();
    far.setUTCFullYear(far.getUTCFullYear() + 1);

    const answer = dataOf<Slots>(await slotsFor({ date: isoDay(far) }));
    expect(answer.slots.length).toBeGreaterThan(0);
  });
});

describe("who may ask, and what they may ask", () => {
  test("a master asks for their own day", async () => {
    expect((await slotsFor({}, master)).status).toBe(200);
  });

  test("another master's day is answered as one that does not exist", async () => {
    const response = await slotsFor({}, stranger);
    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("SPECIALIST_NOT_FOUND");
  });

  test("an analyst, who books nobody, is refused", async () => {
    expect((await slotsFor({}, analyst)).status).toBe(403);
  });

  test("a stranger to the studio is not signed in", async () => {
    expect((await slotsFor({}, anonymous)).status).toBe(401);
  });

  test("a date that is not a date is refused", async () => {
    const response = await slotsFor({ date: "2026-02-30" });
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
  });

  test("a service named twice is refused", async () => {
    const response = await slotsFor({ services: `${studio.serviceId}|${studio.serviceId}` });
    expect(response.status).toBe(422);
  });

  test("a malformed sitting is refused", async () => {
    expect((await slotsFor({ services: "not-an-id" })).status).toBe(422);
  });

  test("an address that is not the studio's is not found", async () => {
    const response = await slotsFor({ location_id: crypto.randomUUID() });
    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("LOCATION_NOT_FOUND");
  });

  test("a master who does not work at the address is refused", async () => {
    const other = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Ботаника", slug: "desk-slots-b", timezone: ZONE }),
    ).id;

    const response = await slotsFor({ location_id: other });
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("SPECIALIST_NOT_AT_LOCATION");
  });
});
