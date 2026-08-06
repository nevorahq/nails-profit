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

  it("reads the delivery rate from finished messages only", () => {
    const report = buildBookingMetricsReport({
      notifications: [
        message(),
        message(),
        message({ status: "dead_letter", attempts: 5 }),
        // Still in the queue: it has neither succeeded nor failed, and counting
        // it either way would move the number for no reason.
        message({ status: "pending", sent_at: null }),
      ],
      now: NOW,
    });

    expect(report.metrics.notification_delivery_rate).toBe(0.667);
    expect(report.metrics.notifications_queued).toBe(1);
    expect(report.metrics.notifications_dead_letter).toBe(1);
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

  it("fails the gate on a single overlapping pair", () => {
    const report = buildBookingMetricsReport({ overlaps: 1, now: NOW });
    expect(report.verdict).toBe("NOT_READY");
    expect(report.criteria.find((row) => row.key === "no_overlapping_bookings")).toMatchObject({
      actual: 1,
      passed: false,
    });
  });

  it("passes only when every criterion does", () => {
    const report = buildBookingMetricsReport({
      bookings: Array.from({ length: 120 }, () => ({ status: "completed", source: "public_booking" })),
      notifications: Array.from({ length: 40 }, () => message()),
      completions: { completed_bookings: 120, visits_from_bookings: 35 },
      now: NOW,
    });

    expect(report.verdict).toBe("PASS");
  });
});
