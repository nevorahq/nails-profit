import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { localToUtc, parseLocalDate, parseLocalTime } from "@/domain/timezone";
import { dataOf, errorCodeOf, type Actor, type ApiResponse } from "../helpers/api";
import { wednesdayAhead } from "../helpers/calendar";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Staff booking over HTTP: idempotency, conflicts and the answer a client gets
 * when the slot goes while they were deciding (roadmap sections 7.5 and 7.6).
 *
 * The concurrency guarantee itself is proved against PostgreSQL in
 * `tests/integration/booking-concurrency.test.ts` — one hundred parallel
 * attempts, one booking. This checks the same rules through the endpoint,
 * where the idempotency key and the error envelope live.
 */
/**
 * A Wednesday `week` weeks ahead, at a wall-clock time in the studio's zone.
 *
 * The file used to name September 2026 outright. Staff may book the past, so
 * most of it went on passing — until the overlap test, whose alternatives are
 * searched forward from the date asked for and stop at today, found nothing
 * left to offer once September was over. Local time rather than UTC, because
 * the rota is local and Chisinau moves from +3 to +2 at the end of October.
 */
function wednesdayAt(week: number, time: string): string {
  return localToUtc(
    parseLocalDate(wednesdayAhead(week))!,
    parseLocalTime(time)!,
    "Europe/Chisinau",
  ).toISOString();
}

const SLOT = wednesdayAt(1, "10:00");

function key(label: string) {
  return `${label}-${crypto.randomUUID()}`;
}

describe("staff bookings", () => {
  let studio: Studio;
  let master: Actor;
  let locationId: string;

  async function book(
    actor: Actor,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ApiResponse<unknown>> {
    return actor.post("/api/v1/bookings", body, { "idempotency-key": idempotencyKey });
  }

  function request(startsAt = SLOT) {
    return {
      location_id: locationId,
      specialist_id: studio.specialistId,
      service_id: studio.serviceId,
      starts_at: startsAt,
    };
  }

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("bookings-owner@studio.example", "Bookings Studio");
    master = await inviteMember(studio.owner, "bookings-master@studio.example", "master");
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "bookings-centru" }),
    ).id;

    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      // Wednesdays, the only day `wednesdayAt` books.
      intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
      effective_from: "2026-08-01",
    });
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("a booking is created with the service's own duration", async () => {
    const created = dataOf<{ id: string; status: string; starts_at: string; ends_at: string }>(
      await book(studio.owner, request(), key("first")),
    );

    expect(created.status).toBe("confirmed");
    // The canonical service is 90 minutes long.
    expect(new Date(created.ends_at).getTime() - new Date(created.starts_at).getTime()).toBe(
      90 * 60_000,
    );

    const list = dataOf<{ id: string; lines: { price_minor: number }[] }[]>(
      await studio.owner.get("/api/v1/bookings"),
    );
    expect(list.map((booking) => booking.id)).toContain(created.id);
    expect(list[0].lines[0].price_minor).toBe(60_000);
  });

  test("the same request with the same key is answered, not booked twice", async () => {
    const retryKey = key("retry");
    const first = dataOf<{ id: string }>(await book(studio.owner, request(wednesdayAt(1, "14:00")), retryKey));
    const again = dataOf<{ id: string; replayed: boolean }>(
      await book(studio.owner, request(wednesdayAt(1, "14:00")), retryKey),
    );

    // A client tapping "confirm" twice on a slow connection is not asking for
    // two Tuesdays.
    expect(again.id).toBe(first.id);
    expect(again.replayed).toBe(true);
  });

  test("the same key for a different request is refused", async () => {
    const reused = key("reused");
    await book(studio.owner, request(wednesdayAt(1, "16:00")), reused);

    const response = await book(studio.owner, request(wednesdayAt(1, "18:00")), reused);
    expect(response.status).toBe(409);
    // Answering with the first booking would hand back an appointment at a time
    // nobody asked for.
    expect(errorCodeOf(response)).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("a create without a key is refused outright", async () => {
    const response = await studio.owner.post("/api/v1/bookings", request(wednesdayAt(2, "10:00")));
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("an overlapping booking is refused with the next free times", async () => {
    // 10:00–11:30 is taken by the first test; 11:00 overlaps it.
    const response = await book(studio.owner, request(wednesdayAt(1, "11:00")), key("overlap"));

    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("SLOT_UNAVAILABLE");

    const details = (response.body as { error: { details: { conflict: string; alternatives: unknown[] } } })
      .error.details;
    expect(details.conflict).toBe("booking");
    // Section 7.5: losing the race is when a client is likeliest to give up, so
    // the refusal carries the next thing to do.
    expect(details.alternatives.length).toBeGreaterThan(0);
  });

  test("back-to-back bookings are not a conflict", async () => {
    const response = await book(studio.owner, request(wednesdayAt(1, "11:30")), key("adjacent"));
    expect(response.status).toBe(201);
  });

  test("simultaneous requests for one slot produce one booking", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        book(studio.owner, request(wednesdayAt(3, "10:00")), key(`race-${index}`)),
      ),
    );

    expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(19);
    for (const refused of attempts.filter((response) => response.status === 409)) {
      expect(errorCodeOf(refused)).toBe("SLOT_UNAVAILABLE");
    }
  });

  test("a specialist who does not work at the location cannot be booked there", async () => {
    const elsewhere = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Филиал", slug: "bookings-filial" }),
    ).id;

    const response = await book(
      studio.owner,
      {
        location_id: elsewhere,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        starts_at: wednesdayAt(4, "10:00"),
      },
      key("elsewhere"),
    );

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("SPECIALIST_NOT_AT_LOCATION");
  });

  test("a master books their own calendar and sees only it", async () => {
    const own = await book(master, request(wednesdayAt(5, "10:00")), key("master-own"));
    expect(own.status).toBe(201);

    const other = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Коллега" }),
    ).id;

    const forSomeoneElse = await book(
      master,
      {
        location_id: locationId,
        specialist_id: other,
        service_id: studio.serviceId,
        starts_at: wednesdayAt(5, "14:00"),
      },
      key("master-other"),
    );
    expect(forSomeoneElse.status).toBe(403);

    const visible = dataOf<{ specialist_id: string }[]>(await master.get("/api/v1/bookings"));
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((booking) => booking.specialist_id === studio.specialistId)).toBe(true);
  });

  test("the next free times on a later day leave out what is booked on it", async () => {
    // Regression: the alternatives searched forward from the day asked for but
    // loaded the busy time of that one day, so the following Wednesday was
    // offered whole, the appointment already standing in it included.
    expect((await book(studio.owner, request(wednesdayAt(7, "10:00")), key("later-day"))).status).toBe(201);
    expect((await book(studio.owner, request(wednesdayAt(6, "10:00")), key("asked-day"))).status).toBe(201);

    const response = await book(studio.owner, request(wednesdayAt(6, "10:30")), key("later-overlap"));
    expect(errorCodeOf(response)).toBe("SLOT_UNAVAILABLE");

    const { alternatives } = (
      response.body as { error: { details: { alternatives: { date: string; slots: string[] }[] } } }
    ).error.details;
    const laterDay = alternatives.find((entry) => entry.date === wednesdayAhead(7));
    expect(laterDay).toBeDefined();

    const taken = { start: Date.parse(wednesdayAt(7, "10:00")), end: Date.parse(wednesdayAt(7, "11:30")) };
    const overlapping = laterDay!.slots.filter((slot) => {
      const start = Date.parse(slot);
      return start < taken.end && start + 90 * 60_000 > taken.start;
    });
    expect(overlapping).toEqual([]);
  });

  test("another organization sees none of these bookings", async () => {
    const other = await createCanonicalStudio("bookings-other@studio.example", "Other Bookings");
    expect(dataOf<unknown[]>(await other.owner.get("/api/v1/bookings"))).toHaveLength(0);
  });
});
