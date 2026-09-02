import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { generateSlots, type ScheduleRuleInput } from "@/domain/availability";
import { toZonedParts, type Weekday } from "@/domain/timezone";
import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * Phase 7.1 end to end: a studio configures where it works, when, and what it
 * refuses to offer — and the availability engine reads back exactly that.
 *
 * The engine has its own unit tests with hand-written rules. This one closes
 * the other half of the loop: that what the API stores is what the engine is
 * later handed. A rota that round-trips through the database with its weekday
 * off by one, or its minutes read as a local time in the wrong zone, would pass
 * every test on either side of the boundary and fail here.
 */
const CHISINAU = "Europe/Chisinau";
/** 5 August 2026, a Wednesday. */
const WEDNESDAY = { year: 2026, month: 8, day: 5 };

type RuleRow = {
  weekday: number;
  start_minute: number;
  end_minute: number;
  effective_from: string;
  effective_to: string | null;
};

type ExceptionRow = {
  id: string;
  specialist_id: string;
  kind: "available" | "unavailable";
  starts_at: string;
  ends_at: string;
};

function localTimes(slots: readonly { start: Date }[]) {
  return slots.map((slot) => {
    const parts = toZonedParts(slot.start, CHISINAU);
    return `${String(Math.floor(parts.minutes / 60)).padStart(2, "0")}:${String(parts.minutes % 60).padStart(2, "0")}`;
  });
}

describe("configuring a bookable studio", () => {
  let studio: Studio;
  let master: Actor;
  let locationId: string;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("booking-owner@studio.example", "Booking Studio");
    master = await inviteMember(studio.owner, "booking-master@studio.example", "master");
    await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "centru",
        address: "str. Ismail 33",
        timezone: CHISINAU,
      }),
    ).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("a location arrives with a usable booking configuration", async () => {
    const [location] = dataOf<{ id: string; timezone: string; public_status: string; slot_step_minutes: number }[]>(
      await studio.owner.get("/api/v1/locations"),
    );

    expect(location).toMatchObject({
      id: locationId,
      timezone: CHISINAU,
      // Created in the same transaction as the location: settings that exist
      // are easier to reason about than nulls meaning "ask somewhere else".
      public_status: "draft",
      slot_step_minutes: 15,
    });
  });

  test("an unknown timezone is refused rather than quietly treated as UTC", async () => {
    const response = await studio.owner.post("/api/v1/locations", {
      name: "Марс",
      slug: "mars",
      timezone: "Mars/Olympus",
    });

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("UNKNOWN_TIMEZONE");
  });

  test("a slug is a public address, so it is validated and unique", async () => {
    const reserved = await studio.owner.post("/api/v1/locations", { name: "Админ", slug: "admin" });
    expect(errorCodeOf(reserved)).toBe("INVALID_SLUG");

    const taken = await studio.owner.post("/api/v1/locations", { name: "Второй", slug: "centru" });
    expect(taken.status).toBe(409);
    expect(errorCodeOf(taken)).toBe("SLUG_TAKEN");
  });

  test("the rota stored is the rota the engine reads back", async () => {
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
      location_ids: [locationId],
    });
    await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/services`, {
      services: [{ service_id: studio.serviceId, duration_minutes: 60 }],
    });

    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      effective_from: "2026-08-01",
      intervals: [
        { weekday: 3, start: "09:00", end: "13:00" },
        { weekday: 3, start: "14:00", end: "18:00" },
      ],
    });

    const rules = dataOf<RuleRow[]>(
      await studio.owner.get(`/api/v1/availability/rules?specialist_id=${studio.specialistId}`),
    );

    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ weekday: 3, start_minute: 540, end_minute: 780, effective_to: null });

    const slots = generateSlots({
      date: WEDNESDAY,
      timezone: CHISINAU,
      durationMinutes: 60,
      rules: rules.map(
        (rule): ScheduleRuleInput => ({
          weekday: rule.weekday as Weekday,
          startMinute: rule.start_minute,
          endMinute: rule.end_minute,
          effectiveFrom: rule.effective_from,
          effectiveTo: rule.effective_to,
        }),
      ),
      exceptions: [],
      busy: [],
      settings: {
        slotStepMinutes: 30,
        minLeadMinutes: 0,
        maxAdvanceDays: 60,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      },
      now: new Date("2026-08-05T02:00:00Z"),
    });

    const times = localTimes(slots);
    expect(times[0]).toBe("09:00");
    // The lunch break is a gap in the rota, so no slot may start at 12:30 and
    // run through it.
    expect(times).toContain("12:00");
    expect(times).not.toContain("12:30");
    expect(times).not.toContain("13:00");
    expect(times).toContain("14:00");
    expect(times.at(-1)).toBe("17:00");
  });

  test("overlapping intervals in one submission are refused, not merged", async () => {
    const response = await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      effective_from: "2026-08-01",
      intervals: [
        { weekday: 4, start: "09:00", end: "13:00" },
        { weekday: 4, start: "12:00", end: "18:00" },
      ],
    });

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("OVERLAPPING_INTERVALS");
  });

  test("a rota replaced from a future date keeps the pattern that already applied", async () => {
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      effective_from: "2026-09-01",
      intervals: [{ weekday: 3, start: "10:00", end: "16:00" }],
    });

    const all = dataOf<RuleRow[]>(
      await studio.owner.get(
        `/api/v1/availability/rules?specialist_id=${studio.specialistId}&include_expired=true`,
      ),
    );

    const closed = all.filter((rule) => rule.effective_to !== null);
    const open = all.filter((rule) => rule.effective_to === null);

    // The August pattern is closed on the day the September one starts —
    // exclusive end, inclusive start, so no day has two patterns and none has
    // none. A booking taken in August still resolves against August.
    expect(closed).toHaveLength(2);
    expect(closed.every((rule) => rule.effective_to === "2026-09-01")).toBe(true);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ start_minute: 600, end_minute: 960, effective_from: "2026-09-01" });
  });

  test("a rota corrected before it takes effect leaves nothing behind", async () => {
    await studio.owner.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      effective_from: "2026-09-01",
      intervals: [{ weekday: 3, start: "11:00", end: "15:00" }],
    });

    const all = dataOf<RuleRow[]>(
      await studio.owner.get(
        `/api/v1/availability/rules?specialist_id=${studio.specialistId}&include_expired=true`,
      ),
    );

    // The first September attempt never applied to a single day, so it is
    // replaced rather than closed into a range valid for no date at all.
    const september = all.filter((rule) => rule.effective_from === "2026-09-01");
    expect(september).toHaveLength(1);
    expect(september[0].start_minute).toBe(660);
  });

  test("an exception removes exactly the hours it names", async () => {
    const created = dataOf<ExceptionRow>(
      await studio.owner.post("/api/v1/availability/exceptions", {
        specialist_id: studio.specialistId,
        location_id: locationId,
        kind: "unavailable",
        // 12:00–13:00 local on the Wednesday, in UTC as section 7.6 requires.
        starts_at: "2026-08-05T09:00:00.000Z",
        ends_at: "2026-08-05T10:00:00.000Z",
        reason: "обучение",
      }),
    );

    const exceptions = dataOf<ExceptionRow[]>(
      await studio.owner.get("/api/v1/availability/exceptions?from=2026-08-01T00:00:00.000Z"),
    );
    expect(exceptions.map((entry) => entry.id)).toContain(created.id);

    // Expired ones included, and filtered below by the date this test is about.
    // The rota for that Wednesday was closed by the test above the moment the
    // real calendar reached September, and asking only for the rules in force
    // today would leave this one with no working hours to remove an hour from.
    const rules = dataOf<RuleRow[]>(
      await studio.owner.get(
        `/api/v1/availability/rules?specialist_id=${studio.specialistId}&include_expired=true`,
      ),
    );

    const slots = generateSlots({
      date: WEDNESDAY,
      timezone: CHISINAU,
      durationMinutes: 60,
      rules: rules
        .filter((rule) => rule.effective_from <= "2026-08-05")
        .map(
          (rule): ScheduleRuleInput => ({
            weekday: rule.weekday as Weekday,
            startMinute: rule.start_minute,
            endMinute: rule.end_minute,
            effectiveFrom: rule.effective_from,
            effectiveTo: rule.effective_to,
          }),
        ),
      exceptions: exceptions.map((entry) => ({
        kind: entry.kind,
        start: new Date(entry.starts_at),
        end: new Date(entry.ends_at),
      })),
      busy: [],
      settings: {
        slotStepMinutes: 30,
        minLeadMinutes: 0,
        maxAdvanceDays: 60,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      },
      now: new Date("2026-08-05T02:00:00Z"),
    });

    const times = localTimes(slots);
    expect(times).toContain("11:00");
    expect(times).not.toContain("11:30");
    expect(times).not.toContain("12:00");
    expect(times).toContain("14:00");
  });

  test("a master may set their own rota and nobody else's", async () => {
    const other = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Коллега по графику" }),
    ).id;
    await studio.owner.put(`/api/v1/specialists/${other}/locations`, { location_ids: [locationId] });

    const own = await master.put("/api/v1/availability/rules", {
      specialist_id: studio.specialistId,
      location_id: locationId,
      effective_from: "2026-09-01",
      intervals: [{ weekday: 1, start: "10:00", end: "16:00" }],
    });
    expect(own.status).toBe(201);

    // The rota decides which clients reach whom. Owning one's own hours is not
    // owning a colleague's, and the endpoint is where that line is drawn —
    // `tests/e2e/rbac-matrix.test.ts` can only say who may call it at all.
    const someoneElse = await master.put("/api/v1/availability/rules", {
      specialist_id: other,
      location_id: locationId,
      effective_from: "2026-09-01",
      intervals: [{ weekday: 1, start: "10:00", end: "16:00" }],
    });
    expect(someoneElse.status).toBe(403);
  });

  test("a master may block their own time and nobody else's", async () => {
    const other = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Коллега" }),
    ).id;

    const own = await master.post("/api/v1/availability/exceptions", {
      specialist_id: studio.specialistId,
      kind: "unavailable",
      starts_at: "2026-08-12T09:00:00.000Z",
      ends_at: "2026-08-12T10:00:00.000Z",
    });
    expect(own.status).toBe(201);

    const someoneElse = await master.post("/api/v1/availability/exceptions", {
      specialist_id: other,
      kind: "unavailable",
      starts_at: "2026-08-12T09:00:00.000Z",
      ends_at: "2026-08-12T10:00:00.000Z",
    });
    expect(someoneElse.status).toBe(403);

    // And what a master can see is their own schedule, not the studio's.
    const visible = dataOf<ExceptionRow[]>(await master.get("/api/v1/availability/exceptions"));
    expect(visible.every((entry) => entry.specialist_id === studio.specialistId)).toBe(true);
  });

  test("an exception must end after it starts", async () => {
    const response = await studio.owner.post("/api/v1/availability/exceptions", {
      specialist_id: studio.specialistId,
      kind: "unavailable",
      starts_at: "2026-08-20T10:00:00.000Z",
      ends_at: "2026-08-20T10:00:00.000Z",
    });

    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("INVALID_INTERVAL");
  });

  test("booking settings are bounded by the database, not only by the schema", async () => {
    const response = await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
      slot_step_minutes: 7,
    });
    expect(response.status).toBe(422);

    const accepted = dataOf<{ public_status: string; min_lead_minutes: number }>(
      await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
        public_status: "published",
        min_lead_minutes: 60,
        confirmation_mode: "manual",
      }),
    );
    expect(accepted).toMatchObject({ public_status: "published", min_lead_minutes: 60 });
  });
});
