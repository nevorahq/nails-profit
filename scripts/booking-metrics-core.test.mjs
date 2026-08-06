import { describe, expect, it } from "vitest";

import { buildBookingMetricsReport } from "./booking-metrics-core.mjs";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function message(overrides = {}) {
  return {
    status: "sent",
    template: "booking.confirmed",
    attempts: 1,
    next_attempt_at: new Date("2026-09-10T11:00:00.000Z"),
    scheduled_at: new Date("2026-09-10T11:00:00.000Z"),
    sent_at: new Date("2026-09-10T11:00:01.000Z"),
    provider_status: "delivered",
    provider_event_at: new Date("2026-09-10T11:00:02.000Z"),
    ...overrides,
  };
}

describe("booking metrics", () => {
  it("counts what a pilot is asked about", () => {
    const report = buildBookingMetricsReport({
      bookings: [
        { status: "confirmed", source: "public_booking" },
        { status: "confirmed", source: "staff" },
        { status: "completed", source: "public_booking" },
        { status: "cancelled", source: "public_booking" },
      ],
      holds: [{ status: "converted" }, { status: "expired" }, { status: "active" }],
      completions: { completed_bookings: 1, visits_from_bookings: 1 },
      now: NOW,
    });

    expect(report.metrics.bookings_total).toBe(4);
    expect(report.metrics.active_bookings).toBe(2);
    expect(report.metrics.bookings_by_source.public_booking).toBe(3);
    // Two holds finished, one of them became an appointment.
    expect(report.metrics.hold_conversion_rate).toBe(0.5);
    expect(report.metrics.holds_active).toBe(1);
  });

  it("reads the on-time delivery rate from eligible messages only", () => {
    const report = buildBookingMetricsReport({
      notifications: [
        message(),
        message(),
        message({ status: "dead_letter", attempts: 5, provider_status: null, provider_event_at: null }),
        // Still in the queue: it has neither succeeded nor failed, and counting
        // it either way would move the number for no reason.
        message({
          status: "pending",
          scheduled_at: new Date("2026-09-10T13:00:00.000Z"),
          next_attempt_at: new Date("2026-09-10T13:00:00.000Z"),
          sent_at: null,
          provider_status: null,
          provider_event_at: null,
        }),
      ],
      now: NOW,
    });

    expect(report.metrics.notification_delivery_rate).toBe(0.667);
    expect(report.metrics.notification_provider_acceptance_rate).toBe(0.667);
    expect(report.metrics.notification_mail_server_delivery_rate).toBe(1);
    expect(report.metrics.notification_provider_statuses.delivered).toBe(2);
    expect(report.metrics.notifications_queued).toBe(1);
    expect(report.metrics.notifications_dead_letter).toBe(1);
  });

  it("separates provider acceptance from mail-server delivery outcomes", () => {
    const report = buildBookingMetricsReport({
      notifications: [
        message(),
        message({ provider_status: "bounced" }),
        message({ provider_status: "failed" }),
        message({ provider_status: "delayed" }),
      ],
      now: NOW,
    });

    expect(report.metrics.notification_provider_acceptance_rate).toBe(1);
    expect(report.metrics.notification_mail_server_delivery_rate).toBe(0.333);
    expect(report.metrics.notification_provider_statuses).toMatchObject({
      delivered: 1,
      bounced: 1,
      failed: 1,
      delayed: 1,
    });
  });

  it("counts a message still queued after two minutes as a delivery miss", () => {
    const report = buildBookingMetricsReport({
      notifications: [
        message(),
        message({ status: "processing", sent_at: null }),
      ],
      now: NOW,
    });

    expect(report.metrics.notification_provider_acceptance_rate).toBe(1);
    expect(report.metrics.notification_delivery_rate).toBe(0.5);
    expect(report.metrics.notifications_overdue_delivery).toBe(1);
  });

  it("does not count a late provider handoff toward the two-minute gate", () => {
    const report = buildBookingMetricsReport({
      notifications: [
        message(),
        message({ sent_at: new Date("2026-09-10T11:02:01.000Z") }),
      ],
      now: NOW,
    });

    expect(report.metrics.notification_provider_acceptance_rate).toBe(1);
    expect(report.metrics.notification_delivery_rate).toBe(0.5);
    expect(report.metrics.notifications_sent_within_two_minutes).toBe(1);
    expect(report.criteria.find((row) => row.key === "notification_delivery_rate")).toMatchObject({
      actual: 0.5,
      passed: false,
    });
  });

  it("has no delivery rate before anything has been sent", () => {
    const report = buildBookingMetricsReport({ notifications: [], now: NOW });
    // Null rather than 1.0 or 0: an empty queue is not 100% delivery, and a
    // gate that passes on no data is a gate that passes on a broken job.
    expect(report.metrics.notification_delivery_rate).toBeNull();
    expect(report.criteria.find((row) => row.key === "notification_delivery_rate").passed).toBe(false);
  });

  it("measures job lag from the oldest message that is already due", () => {
    const report = buildBookingMetricsReport({
      notifications: [
        message({ status: "pending", next_attempt_at: new Date("2026-09-10T11:50:00.000Z"), sent_at: null }),
        message({ status: "retry", next_attempt_at: new Date("2026-09-10T11:00:00.000Z"), sent_at: null }),
        // Scheduled for tomorrow: a reminder waiting its turn is not lag.
        message({ status: "pending", next_attempt_at: new Date("2026-09-11T09:00:00.000Z"), sent_at: null }),
      ],
      now: NOW,
    });

    expect(report.metrics.notification_job_lag_seconds).toBe(3_600);
    expect(report.metrics.notifications_due).toBe(2);
    expect(report.criteria.find((row) => row.key === "scheduler_keeps_up").passed).toBe(false);
  });

  it("separates a client who never typed the code from one who ran out of tries", () => {
    const report = buildBookingMetricsReport({
      verifications: [
        { verified_at: new Date("2026-09-10T10:00:00.000Z"), attempts: 1, expires_at: NOW },
        { verified_at: null, attempts: 5, expires_at: new Date("2026-09-10T11:00:00.000Z") },
        { verified_at: null, attempts: 0, expires_at: new Date("2026-09-10T11:00:00.000Z") },
      ],
      now: NOW,
    });

    expect(report.metrics.verification_success_rate).toBe(0.333);
    expect(report.metrics.verifications_locked_out).toBe(1);
    expect(report.metrics.verifications_abandoned).toBe(1);
  });

  describe("the funnel", () => {
    function event(name, session, overrides = {}) {
      return {
        event_name: name,
        entity_id: overrides.entity_id ?? "entity",
        session_key: session,
        occurred_at: overrides.occurred_at ?? NOW,
      };
    }

    it("counts visits, not events", () => {
      const report = buildBookingMetricsReport({
        events: [
          event("booking_page_viewed", "visit-1"),
          event("booking_page_viewed", "visit-2"),
          event("booking_availability_searched", "visit-1", { entity_id: "service-a" }),
          // The same visit looking at a second service is still one visit.
          event("booking_availability_searched", "visit-1", { entity_id: "service-b" }),
          event("booking_started", "visit-1", { entity_id: "booking-1" }),
          event("booking_confirmed", "visit-1", { entity_id: "booking-1" }),
          event("booking_completed", "", { entity_id: "booking-1" }),
        ],
        now: NOW,
      });

      expect(report.funnel).toEqual([
        { step: "page_viewed", visits: 2, from_previous: null, from_start: null },
        { step: "availability_searched", visits: 1, from_previous: 0.5, from_start: 0.5 },
        { step: "booking_started", visits: 1, from_previous: 1, from_start: 0.5 },
        { step: "booking_confirmed", visits: 1, from_previous: 1, from_start: 0.5 },
        { step: "visit_completed", visits: 1, from_previous: 1, from_start: 0.5 },
      ]);
      expect(report.metrics.booking_conversion_rate).toBe(0.5);
    });

    it("ignores events with no visit behind them", () => {
      const report = buildBookingMetricsReport({
        // A booking taken at the desk is not a visit to the public page, and
        // counting it as one would report a funnel nobody walked.
        events: [
          event("booking_started", "", { entity_id: "booking-staff" }),
          event("booking_confirmed", "", { entity_id: "booking-staff" }),
        ],
        now: NOW,
      });

      expect(report.funnel[2].visits).toBe(0);
      expect(report.funnel[3].visits).toBe(0);
    });

    it("counts a completion only for a booking a visit confirmed", () => {
      const report = buildBookingMetricsReport({
        events: [
          event("booking_confirmed", "visit-1", { entity_id: "booking-public" }),
          event("booking_completed", "", { entity_id: "booking-public" }),
          // Completed, but it came from the calendar rather than the page.
          event("booking_completed", "", { entity_id: "booking-staff" }),
        ],
        now: NOW,
      });

      expect(report.funnel[4].visits).toBe(1);
    });

    it("measures time to book per visit and takes the median", () => {
      const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);
      const report = buildBookingMetricsReport({
        events: [
          event("booking_service_selected", "visit-1", { occurred_at: at(0) }),
          // A second look at the catalogue does not restart the clock.
          event("booking_service_selected", "visit-1", { occurred_at: at(1) }),
          event("booking_confirmed", "visit-1", { occurred_at: at(1.5), entity_id: "b1" }),
          event("booking_service_selected", "visit-2", { occurred_at: at(0) }),
          event("booking_confirmed", "visit-2", { occurred_at: at(5), entity_id: "b2" }),
          event("booking_service_selected", "visit-3", { occurred_at: at(0) }),
          event("booking_confirmed", "visit-3", { occurred_at: at(1), entity_id: "b3" }),
        ],
        now: NOW,
      });

      // 90 s, 300 s and 60 s: the middle one is the answer, and the abandoned
      // visits contribute nothing because they never confirmed.
      expect(report.metrics.time_to_book_median_seconds).toBe(90);
      expect(report.metrics.time_to_book_samples).toBe(3);
      expect(report.criteria.find((row) => row.key === "time_to_book")).toMatchObject({
        actual: 90,
        passed: true,
      });
    });

    it("fails the gate when nobody has booked yet", () => {
      const report = buildBookingMetricsReport({ events: [], now: NOW });
      // Null, not zero: no measurement is not a fast flow.
      expect(report.metrics.time_to_book_median_seconds).toBeNull();
      expect(report.criteria.find((row) => row.key === "time_to_book").passed).toBe(false);
    });
  });

  it("fails the gate on a single overlapping pair", () => {
    const report = buildBookingMetricsReport({ overlaps: 1, now: NOW });
    expect(report.verdict).toBe("NOT_READY");
    expect(report.criteria.find((row) => row.key === "no_overlapping_bookings")).toMatchObject({
      actual: 1,
      passed: false,
    });
  });

  it("passes only when every criterion does", () => {
    const passing = {
      bookings: Array.from({ length: 120 }, () => ({ status: "completed", source: "public_booking" })),
      notifications: Array.from({ length: 40 }, () => message()),
      completions: { completed_bookings: 120, visits_from_bookings: 35 },
      events: [
        {
          event_name: "booking_service_selected",
          entity_id: "service",
          session_key: "visit-1",
          occurred_at: NOW,
        },
        {
          event_name: "booking_confirmed",
          entity_id: "booking-1",
          session_key: "visit-1",
          occurred_at: new Date(NOW.getTime() + 80_000),
        },
      ],
      now: NOW,
    };

    expect(buildBookingMetricsReport(passing).verdict).toBe("PASS");

    // One criterion short of the whole set is still NOT_READY: a gate that
    // passes on five of six is not a gate.
    expect(buildBookingMetricsReport({ ...passing, events: [] }).verdict).toBe("NOT_READY");
  });
});
