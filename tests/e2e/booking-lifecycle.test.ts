import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf, errorCodeOf, type Actor, type ApiResponse } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * What happens to an appointment after it is made: confirm, move, cancel, mark
 * a no-show, and close it into a visit (roadmap sections 7.2 and 7.6).
 *
 * The state machine is the point. Every one of these endpoints can be reached
 * twice — a second tap, a stale tab, two people at the same reception desk —
 * and the second attempt must not produce a second outcome.
 */
type Booking = Readonly<{
  id: string;
  status: string;
  version: number;
  starts_at: string;
  ends_at: string;
  specialist_id: string;
}>;

function key(label: string) {
  return `${label}-${crypto.randomUUID()}`;
}

describe("booking lifecycle", () => {
  let studio: Studio;
  let manual: Studio;
  let master: Actor;
  let locationId: string;
  let issued = 0;

  /**
   * The first Wednesday a week out, derived from the clock rather than written
   * down. A fixed date drifts out of the location's booking window as the
   * calendar passes it, and the failure then looks like a bug in availability
   * rather than an expired fixture.
   */
  const firstWednesday = (() => {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    return day;
  })();

  /**
   * A fresh slot on a working Wednesday, so no test contends for another's.
   * Six a day, then the following week — inside the rota either way, which is
   * what lets a refusal come back with real alternatives.
   */
  function nextSlot() {
    const index = issued++;
    const start = new Date(firstWednesday);
    start.setUTCDate(start.getUTCDate() + 7 * Math.floor(index / 6));
    start.setUTCHours(6 + 2 * (index % 6));
    return start.toISOString();
  }

  async function book(
    actor: Actor = studio.owner,
    overrides: Record<string, unknown> = {},
  ): Promise<Booking> {
    return dataOf<Booking>(
      await actor.post(
        "/api/v1/bookings",
        {
          location_id: locationId,
          specialist_id: studio.specialistId,
          service_id: studio.serviceId,
          starts_at: nextSlot(),
          ...overrides,
        },
        { "idempotency-key": key("lifecycle") },
      ),
    );
  }

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("lifecycle-owner@studio.example", "Lifecycle Studio");
    // A second studio with the same catalogue, so the booking flow and the
    // manual flow can be compared without one polluting the other's calendar.
    manual = await createCanonicalStudio("lifecycle-manual@studio.example", "Manual Studio");
    master = await inviteMember(studio.owner, "lifecycle-master@studio.example", "master");
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "lifecycle-centru" }),
    ).id;

    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    // Wednesdays, which every slot in this suite falls on.
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      intervals: [{ weekday: 3, start: "07:00", end: "21:00" }],
      effective_from: new Date().toISOString().slice(0, 10),
    });
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("the card carries the lines, the client and the audit history", async () => {
    const created = await book();
    const card = dataOf<{
      id: string;
      lines: { price_minor: number }[];
      price_minor: number;
      history: { event_type: string }[];
    }>(await studio.owner.get(`/api/v1/bookings/${created.id}`));

    expect(card.id).toBe(created.id);
    expect(card.price_minor).toBe(CANONICAL.servicePriceMinor);
    // Section 7.2: "открыть карточку записи с audit history" — who did what to
    // this appointment is the first question asked when a client disputes one.
    expect(card.history.map((event) => event.event_type)).toContain("booking.created");
  });

  test("an appointment cannot be confirmed twice", async () => {
    const created = await book();
    // Staff bookings are agreed on the spot, so they arrive confirmed.
    expect(created.status).toBe("confirmed");

    const again = await studio.owner.post(`/api/v1/bookings/${created.id}/confirm`, {});
    expect(again.status).toBe(409);
    expect(errorCodeOf(again)).toBe("ILLEGAL_TRANSITION");
  });

  test("a location in manual mode still confirms what staff book directly", async () => {
    // Manual mode is about requests arriving from the public page. A booking a
    // receptionist takes over the phone has already been agreed with the
    // client, and leaving it pending would mean the studio had to confirm its
    // own decision before the appointment counted.
    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      confirmation_mode: "manual",
    });

    const created = await book();
    expect(created.status).toBe("confirmed");

    await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      confirmation_mode: "instant",
    });
  });

  test("a cancelled appointment frees its slot and cannot come back", async () => {
    const created = await book();
    const at = created.starts_at;

    const cancelled = dataOf<Booking & { cancellation_reason: string }>(
      await studio.owner.post(`/api/v1/bookings/${created.id}/cancel`, {
        reason: "client_request",
        cancelled_by: "client",
        version: created.version,
      }),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation_reason).toBe("client_request");

    // The slot is on sale again — that is the whole point of an active-status
    // exclusion constraint rather than one over every row.
    const resold = await studio.owner.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        starts_at: at,
      },
      { "idempotency-key": key("resold") },
    );
    expect(resold.status).toBe(201);

    // And the client stays told: nothing may confirm a cancellation away.
    const revived = await studio.owner.post(`/api/v1/bookings/${created.id}/confirm`, {});
    expect(revived.status).toBe(409);
  });

  test("a free-text cancellation reason is refused", async () => {
    const created = await book();
    const response = await studio.owner.post(`/api/v1/bookings/${created.id}/cancel`, {
      // Section 7.9 keeps PII out of booking columns, and this is what a
      // receptionist would otherwise type while on the phone.
      reason: "клиентка заболела, звонила с +37360000000",
      version: created.version,
    });

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
  });

  test("moving an appointment keeps its duration and refuses a taken slot", async () => {
    const created = await book();
    const target = nextSlot();

    const moved = dataOf<Booking>(
      await studio.owner.post(`/api/v1/bookings/${created.id}/reschedule`, {
        starts_at: target,
        version: created.version,
      }),
    );

    expect(moved.starts_at).toBe(target);
    // Ninety minutes were agreed; a move changes when, not what.
    expect(new Date(moved.ends_at).getTime() - new Date(moved.starts_at).getTime()).toBe(
      CANONICAL.serviceDurationMinutes * 60_000,
    );

    const occupied = await book();
    const collision = await studio.owner.post(`/api/v1/bookings/${moved.id}/reschedule`, {
      starts_at: occupied.starts_at,
      version: moved.version,
    });

    expect(collision.status).toBe(409);
    expect(errorCodeOf(collision)).toBe("SLOT_UNAVAILABLE");
    const details = (collision.body as { error: { details: { alternatives: unknown[] } } }).error.details;
    expect(details.alternatives.length).toBeGreaterThan(0);
  });

  test("an appointment may be moved within the day it already occupies", async () => {
    const created = await book();
    // The check has to ignore the booking being moved. Without that exception
    // every same-day reschedule would collide with the appointment's own row.
    const shifted = dataOf<Booking>(
      await studio.owner.post(`/api/v1/bookings/${created.id}/reschedule`, {
        starts_at: new Date(new Date(created.starts_at).getTime() + 15 * 60_000).toISOString(),
        version: created.version,
      }),
    );

    expect(shifted.version).toBe(created.version + 1);
  });

  test("a stale version cannot move an appointment somebody else already moved", async () => {
    const created = await book();
    const first = nextSlot();
    const second = nextSlot();

    await studio.owner.post(`/api/v1/bookings/${created.id}/reschedule`, {
      starts_at: first,
      version: created.version,
    });

    // The second receptionist read the card before the first one saved.
    const late = await studio.owner.post(`/api/v1/bookings/${created.id}/reschedule`, {
      starts_at: second,
      version: created.version,
    });

    expect(late.status).toBe(409);
    expect(errorCodeOf(late)).toBe("VERSION_CONFLICT");
    expect((late.body as { error: { details: { current_version: number } } }).error.details.current_version).toBe(
      created.version + 1,
    );
  });

  test("simultaneous moves onto one slot leave one winner", async () => {
    const target = nextSlot();
    const contenders = await Promise.all([book(), book()]);

    const attempts = await Promise.all(
      contenders.map((booking) =>
        studio.owner.post(`/api/v1/bookings/${booking.id}/reschedule`, {
          starts_at: target,
          version: booking.version,
        }),
      ),
    );

    expect(attempts.filter((response) => response.status === 200)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(1);
  });

  test("a no-show is recorded and is not a cancellation", async () => {
    const created = await book();
    const marked = dataOf<Booking & { cancelled_at: string | null }>(
      await studio.owner.post(`/api/v1/bookings/${created.id}/no-show`, { version: created.version }),
    );

    expect(marked.status).toBe("no_show");
    // A studio reading its month has to tell a slot that was given back from
    // one that was simply wasted.
    expect(marked.cancelled_at).toBeNull();

    const moved = await studio.owner.post(`/api/v1/bookings/${created.id}/reschedule`, {
      starts_at: nextSlot(),
      version: marked.version,
    });
    expect(moved.status).toBe(409);
  });

  test("closing an appointment produces the same snapshot as recording the visit by hand", async () => {
    const created = await book();
    const completed = dataOf<{
      status: string;
      visit: {
        id: string;
        snapshot: {
          revenue_minor: number;
          contribution_margin_minor: number;
          profit_per_hour_minor: number;
          incomplete_reasons: string[];
        };
      };
    }>(
      await studio.owner.post(`/api/v1/bookings/${created.id}/complete`, {
        version: created.version,
      }),
    );

    expect(completed.status).toBe("completed");
    // Gate 7: "booking → visit → profit даёт те же финансовые snapshots, что и
    // ручной visit flow". The canonical studio's numbers, unchanged by the
    // route the visit arrived through.
    expect(completed.visit.snapshot.revenue_minor).toBe(CANONICAL.servicePriceMinor);
    expect(completed.visit.snapshot.contribution_margin_minor).toBe(CANONICAL.contributionMarginMinor);
    expect(completed.visit.snapshot.profit_per_hour_minor).toBe(CANONICAL.profitPerHourMinor);
    expect(completed.visit.snapshot.incomplete_reasons).toEqual([]);

    // The same service entered the manual way, in a studio with the same
    // catalogue: the two have to agree figure for figure.
    const byHand = dataOf<{ snapshot: { revenue_minor: number; contribution_margin_minor: number } }>(
      await manual.owner.post("/api/v1/visits", {
        service_id: manual.serviceId,
        specialist_id: manual.specialistId,
      }),
    );
    expect(byHand.snapshot.revenue_minor).toBe(completed.visit.snapshot.revenue_minor);
    expect(byHand.snapshot.contribution_margin_minor).toBe(
      completed.visit.snapshot.contribution_margin_minor,
    );

    const visible = dataOf<{ id: string }[]>(await studio.owner.get("/api/v1/visits"));
    expect(visible.map((visit) => visit.id)).toContain(completed.visit.id);
  });

  test("an appointment cannot be closed twice", async () => {
    const created = await book();
    await studio.owner.post(`/api/v1/bookings/${created.id}/complete`, {});

    // Double revenue in every report is what this prevents; the partial unique
    // index on `visit.booking_id` is what prevents it when the check is raced.
    const again = await studio.owner.post(`/api/v1/bookings/${created.id}/complete`, {});
    expect(again.status).toBe(409);
  });

  test("a master acts on their own calendar and nothing else", async () => {
    const own = await book(master);
    const confirmed = await master.post(`/api/v1/bookings/${own.id}/cancel`, {
      reason: "client_request",
    });
    expect(confirmed.status).toBe(200);

    const colleague = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Коллега" }),
    ).id;
    await studio.owner.put(`/api/v1/specialists/${colleague}/locations`, { location_ids: [locationId] });
    const theirs = await book(studio.owner, { specialist_id: colleague });

    // Not 403: an id belonging to someone else must not be confirmed as real.
    for (const path of ["confirm", "cancel", "no-show", "complete", "reschedule"]) {
      const response = await master.post(`/api/v1/bookings/${theirs.id}/${path}`, {
        reason: "client_request",
        starts_at: nextSlot(),
        version: theirs.version,
      });
      expect(response.status).toBe(404);
    }

    expect((await master.get(`/api/v1/bookings/${theirs.id}`)).status).toBe(404);
  });

  test("the calendar filters by status and by location", async () => {
    const onlyCancelled = dataOf<Booking[]>(await studio.owner.get("/api/v1/bookings?status=cancelled"));
    expect(onlyCancelled.length).toBeGreaterThan(0);
    expect(onlyCancelled.every((booking) => booking.status === "cancelled")).toBe(true);

    // "Everything still on" is two statuses, so the filter takes a list.
    const live = dataOf<Booking[]>(
      await studio.owner.get("/api/v1/bookings?status=pending_confirmation,confirmed"),
    );
    expect(live.every((booking) => booking.status !== "cancelled")).toBe(true);

    const elsewhere = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Филиал", slug: "lifecycle-filial" }),
    ).id;
    expect(dataOf<Booking[]>(await studio.owner.get(`/api/v1/bookings?location_id=${elsewhere}`))).toHaveLength(
      0,
    );
  });

  test("another organization cannot open or change these appointments", async () => {
    const created = await book();
    const outsider = await createCanonicalStudio("lifecycle-outsider@studio.example", "Outsider");

    const probes: ApiResponse<unknown>[] = [
      await outsider.owner.get(`/api/v1/bookings/${created.id}`),
      await outsider.owner.post(`/api/v1/bookings/${created.id}/confirm`, {}),
      await outsider.owner.post(`/api/v1/bookings/${created.id}/cancel`, { reason: "duplicate" }),
      await outsider.owner.post(`/api/v1/bookings/${created.id}/no-show`, {}),
      await outsider.owner.post(`/api/v1/bookings/${created.id}/complete`, {}),
      await outsider.owner.post(`/api/v1/bookings/${created.id}/reschedule`, {
        starts_at: nextSlot(),
        version: created.version,
      }),
      await outsider.owner.patch(`/api/v1/bookings/${created.id}`, { version: created.version }),
    ];

    // RLS answers before any of these handlers can: the row is not in the
    // outsider's transaction at all.
    for (const probe of probes) expect(probe.status).toBe(404);
  });
});
