import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { notificationOutbox } from "@/db/schema";

import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import {
  adminDb,
  closeTestConnections,
  resetDatabase,
} from "../helpers/database";
import {
  createCanonicalStudio,
  inviteMember,
  type Studio,
} from "../helpers/studio";

/**
 * Moving what follows a visit that ran short or long.
 *
 * Every test takes its own Wednesday, so none of them finds another's bookings
 * in the day it is shifting. Times are written in UTC and chosen to be inside
 * the rota whatever the offset of the studio's zone is: that is what lets the
 * refusals be about the rule being tested and not about daylight saving.
 */
type Booking = Readonly<{
  id: string;
  version: number;
  starts_at: string;
  ends_at: string;
}>;
type Move = Readonly<{
  booking_id: string;
  version: number;
  from: { starts_at: string; ends_at: string };
  to: { starts_at: string; ends_at: string };
}>;

const key = (label: string) => `${label}-${crypto.randomUUID()}`;

describe("shifting the following appointments", () => {
  let studio: Studio;
  let master: Actor;
  let locationId: string;
  let clientId: string;
  let weeks = 1;

  /** A Wednesday of its own, a fortnight or more away. */
  function freshDay() {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7 * ++weeks);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    return day;
  }

  const hour = (day: Date, time: string) => {
    const [h, m] = time.split(":").map(Number);
    const at = new Date(day);
    at.setUTCHours(h, m);
    return at.toISOString();
  };

  /** A booking of an hour and a half, which is the catalogue's one service. */
  async function book(
    day: Date,
    time: string,
    forClient?: string,
  ): Promise<Booking> {
    return dataOf<Booking>(
      await studio.owner.post(
        "/api/v1/bookings",
        {
          location_id: locationId,
          specialist_id: studio.specialistId,
          service_id: studio.serviceId,
          ...(forClient ? { client_id: forClient } : {}),
          starts_at: hour(day, time),
        },
        { "idempotency-key": key("shift") },
      ),
    );
  }

  const card = async (id: string) =>
    dataOf<Booking>(await studio.owner.get(`/api/v1/bookings/${id}`));

  const shift = (
    anchor: Booking,
    body: Record<string, unknown>,
    actor: Actor = studio.owner,
  ) => actor.post(`/api/v1/bookings/${anchor.id}/shift-following`, body);

  const versionsOf = (moves: readonly Move[]) =>
    Object.fromEntries(moves.map((move) => [move.booking_id, move.version]));

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio(
      "shift-owner@studio.example",
      "Shift Studio",
    );
    master = await inviteMember(
      studio.owner,
      "shift-master@studio.example",
      "master",
    );
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, {
      user_id: master.userId,
    });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "shift-centru",
      }),
    ).id;
    await studio.owner.put(
      `/api/v1/specialists/${studio.specialistId}/locations`,
      {
        location_ids: [locationId],
      },
    );
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "07:00", end: "21:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });
    clientId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/clients", {
        name: "Мария",
        phone: "+373 69 777 888",
        email: "maria@example.test",
      }),
    ).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("a visit that ended half an hour early pulls the back-to-back ones forward", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    const next = await book(day, "07:30");
    const after = await book(day, "09:00");
    const lunch = await book(day, "11:30");

    const preview = await shift(anchor, {
      delta_minutes: -30,
      mode: "preview",
    });
    const moves = dataOf<{ moves: Move[] }>(preview).moves;

    expect(moves.map((move) => move.booking_id)).toEqual([next.id, after.id]);
    // A preview writes nothing.
    expect((await card(next.id)).starts_at).toBe(next.starts_at);

    const applied = dataOf<{ moves: Move[] }>(
      await shift(anchor, {
        delta_minutes: -30,
        mode: "apply",
        versions: versionsOf(moves),
      }),
    );
    expect(applied.moves).toHaveLength(2);

    expect(new Date((await card(next.id)).starts_at).toISOString()).toBe(
      hour(day, "07:00"),
    );
    expect(new Date((await card(after.id)).starts_at).toISOString()).toBe(
      hour(day, "08:30"),
    );
    // The appointment with a gap before it was placed there on purpose.
    expect((await card(lunch.id)).starts_at).toBe(lunch.starts_at);
    // The visit corrected ends where it actually ended.
    expect(new Date((await card(anchor.id)).ends_at).toISOString()).toBe(
      hour(day, "07:00"),
    );
    // Durations travel with the moves.
    const movedNext = await card(next.id);
    expect(
      new Date(movedNext.ends_at).getTime() -
        new Date(movedNext.starts_at).getTime(),
    ).toBe(90 * 60_000);
  });

  test("a delay pushes only what it runs into, and a gap absorbs the rest", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    const next = await book(day, "07:30");
    // Half an hour of slack before this one.
    const slack = await book(day, "10:00");

    const moves = dataOf<{ moves: Move[] }>(
      await shift(anchor, { delta_minutes: 20, mode: "preview" }),
    ).moves;
    expect(moves.map((move) => move.booking_id)).toEqual([next.id]);

    await shift(anchor, {
      delta_minutes: 20,
      mode: "apply",
      versions: versionsOf(moves),
    });

    expect((await card(next.id)).starts_at).toBe(
      new Date(hour(day, "07:50")).toISOString(),
    );
    expect((await card(slack.id)).starts_at).toBe(slack.starts_at);
  });

  test("every appointment moved is recorded and its version moves on", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    const next = await book(day, "07:30");

    const moves = dataOf<{ moves: Move[] }>(
      await shift(anchor, { delta_minutes: 15, mode: "preview" }),
    ).moves;
    await shift(anchor, {
      delta_minutes: 15,
      mode: "apply",
      versions: versionsOf(moves),
    });

    const detail = dataOf<{
      version: number;
      history: { event_type: string }[];
    }>(await studio.owner.get(`/api/v1/bookings/${next.id}`));
    expect(detail.version).toBe(next.version + 1);
    expect(detail.history.map((event) => event.event_type)).toContain(
      "booking.rescheduled",
    );
  });

  test("each client moved is told the new time, and the one who was not moved is not", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    const moved = await book(day, "07:30", clientId);
    const slack = await book(day, "11:00", clientId);

    const moves = dataOf<{ moves: Move[] }>(
      await shift(anchor, { delta_minutes: 15, mode: "preview" }),
    ).moves;
    await shift(anchor, {
      delta_minutes: 15,
      mode: "apply",
      versions: versionsOf(moves),
    });

    const templates = async (bookingId: string) =>
      (
        await adminDb
          .select({ template: notificationOutbox.template })
          .from(notificationOutbox)
          .where(eq(notificationOutbox.bookingId, bookingId))
      ).map((row) => row.template);

    expect(await templates(moved.id)).toContain("booking.rescheduled");
    expect(await templates(slack.id)).not.toContain("booking.rescheduled");
  });

  test("a push that would run past the end of the shift moves nothing at all", async () => {
    const day = freshDay();
    // The rota closes at 21:00 local, which is 18:00 or 19:00 UTC.
    const anchor = await book(day, "14:30");
    const early = await book(day, "16:00");

    const refused = await shift(anchor, {
      delta_minutes: 120,
      mode: "preview",
    });

    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe("SHIFT_NOT_POSSIBLE");
    expect(
      (
        refused.body as {
          error: { details: { reason: string; booking_id: string } };
        }
      ).error.details,
    ).toEqual({ reason: "outside_working_hours", booking_id: early.id });
    expect((await card(early.id)).starts_at).toBe(early.starts_at);
  });

  test("an appointment cannot be pulled earlier than the visit before it ended", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    const next = await book(day, "07:30");

    // The visit was booked for an hour and a half: it cannot have freed two.
    const refused = await shift(anchor, {
      delta_minutes: -120,
      mode: "preview",
    });
    expect(refused.status).toBe(409);
    expect(
      (
        refused.body as {
          error: { details: { reason: string; booking_id: string } };
        }
      ).error.details,
    ).toMatchObject({ reason: "too_early", booking_id: next.id });
  });

  test("nothing follows, or the delay fits in the gap: there is nothing to move", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    await book(day, "10:00");

    const refused = await shift(anchor, { delta_minutes: 15, mode: "preview" });
    expect(refused.status).toBe(409);
    expect(
      (refused.body as { error: { details: { reason: string } } }).error.details
        .reason,
    ).toBe("nothing_to_move");
  });

  test("applying with the versions of a day that changed is refused", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    const next = await book(day, "07:30");

    const moves = dataOf<{ moves: Move[] }>(
      await shift(anchor, { delta_minutes: 15, mode: "preview" }),
    ).moves;
    // Somebody else touched the appointment between the preview and the tap:
    // the same hour, a new version.
    await studio.owner.post(`/api/v1/bookings/${next.id}/reschedule`, {
      starts_at: next.starts_at,
      version: next.version,
    });

    const stale = await shift(anchor, {
      delta_minutes: 15,
      mode: "apply",
      versions: versionsOf(moves),
    });
    expect(stale.status).toBe(409);
    expect(errorCodeOf(stale)).toBe("VERSION_CONFLICT");
    expect((await card(next.id)).starts_at).toBe(next.starts_at);
  });

  test("applying needs the versions, and the amount must be a number of minutes that is not zero", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    await book(day, "07:30");

    const noVersions = await shift(anchor, {
      delta_minutes: 15,
      mode: "apply",
    });
    expect(noVersions.status).toBe(422);

    const zero = await shift(anchor, { delta_minutes: 0, mode: "preview" });
    expect(zero.status).toBe(422);

    const absurd = await shift(anchor, { delta_minutes: 600, mode: "preview" });
    expect(absurd.status).toBe(422);
  });

  test("the master of the day may shift it, and an unknown appointment is not found", async () => {
    const day = freshDay();
    const anchor = await book(day, "06:00");
    await book(day, "07:30");

    const own = await shift(
      anchor,
      { delta_minutes: 15, mode: "preview" },
      master,
    );
    expect(own.status).toBe(200);

    const missing = await studio.owner.post(
      `/api/v1/bookings/${crypto.randomUUID()}/shift-following`,
      {
        delta_minutes: 15,
        mode: "preview",
      },
    );
    expect(missing.status).toBe(404);
  });
});
