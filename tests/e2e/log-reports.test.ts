import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { organizations } from "@/db/schema";
import { buildBookingLatencyReport } from "../../scripts/booking-latency-core.mjs";
import { buildLogEventsReport, parseLogLines } from "../../scripts/log-events-core.mjs";
import { anonymous, dataOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The contract between what the application writes and what the operator
 * reports read, roadmap section 7.10.
 *
 * Both report cores are unit-tested against records built by hand, which proves
 * their arithmetic and nothing about the pipe. What actually breaks is a field
 * renamed on one side of it: `duration_ms` becomes `durationMs`, every record
 * is silently dropped as malformed, and a green suite reports a fleet with no
 * traffic. So this drives real requests, captures the lines they really write,
 * and runs both reports over them.
 */
type Slot = { starts_at: string; specialist_id: string };

describe("log metrics", () => {
  let studio: Studio;
  let locationId: string;
  const previousFlag = process.env.PUBLIC_BOOKING_ENABLED;

  function nextWednesday(weeksAhead = 1) {
    const day = new Date();
    day.setUTCHours(9, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 7 * weeksAhead);
    while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
    return day;
  }

  beforeAll(async () => {
    process.env.PUBLIC_BOOKING_ENABLED = "true";
    await resetDatabase();
    studio = await createCanonicalStudio("log-metrics-owner@studio.example", "Log Studio");
    await studio.owner.patch("/api/v1/organizations/settings", { slug: "log-studio" });

    locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", {
        name: "Центр",
        slug: "log-centru",
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
    await closeTestConnections();
  });

  test("the report reads the lines the application actually writes", async () => {
    const captured: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line === "string") captured.push(line);
    });

    try {
      const date = nextWednesday().toISOString().slice(0, 10);
      const availability = dataOf<{ slots: Slot[] }>(
        await anonymous.get(
          `/api/v1/public/booking/log-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=any&date=${date}`,
        ),
      );
      const slot = availability.slots[0];

      const held = dataOf<{ hold_token: string }>(
        await anonymous.post("/api/v1/public/booking/log-studio/holds", {
          location_id: locationId,
          service_id: studio.serviceId,
          add_on_ids: [],
          specialist_id: slot.specialist_id,
          starts_at: slot.starts_at,
        }),
      );

      const body = {
        hold_token: held.hold_token,
        service_id: studio.serviceId,
        add_on_ids: [],
        name: "Вера",
        phone: "+373 69 707 070",
        email: null,
        locale: "ru",
        legal_accepted: true,
      };
      await anonymous.post("/api/v1/public/booking/log-studio/bookings", body, {
        "idempotency-key": `log-${crypto.randomUUID()}`,
      });
      // The hold is spent, so this one is refused — a mutation that is measured
      // like any other and counted as a refusal rather than a failure.
      const refused = await anonymous.post("/api/v1/public/booking/log-studio/bookings", body, {
        "idempotency-key": `log-${crypto.randomUUID()}`,
      });
      expect(refused.status).toBe(409);
    } finally {
      spy.mockRestore();
    }

    const { lines } = parseLogLines(captured.join("\n"));
    const events = buildLogEventsReport({ lines });

    // The events report: one search, two creates, one of them refused.
    expect(events.requests["public.availability"]).toMatchObject({ requests: 1, failed: 0 });
    expect(events.requests["public.booking.create"]).toMatchObject({
      requests: 2,
      refused: 1,
      failed: 0,
    });
    expect(events.booking.mutation_attempts).toBe(2);
    expect(events.window.from).not.toBeNull();

    // The latency report reads the same lines, so a renamed field breaks here
    // rather than in a pilot's weekly evidence.
    const latency = buildBookingLatencyReport(lines, { minSamples: 1 });
    expect(latency.accepted_samples).toBe(3);
    expect(latency.routes["public.availability"].samples).toBe(1);
    const mutation = latency.criteria.find((row) => row.key === "booking_mutation");
    expect(mutation?.samples).toBe(2);
    expect(mutation?.p95_ms).toBeGreaterThanOrEqual(0);
  });
});
