import { describe, expect, it } from "vitest";

import { buildLogEventsReport, parseLogLines } from "./log-events-core.mjs";

function timing(route, status = 200, duration_ms = 100) {
  return {
    level: "info",
    event: "http.timing",
    timestamp: "2026-09-10T12:00:00.000Z",
    route,
    duration_ms,
    status,
  };
}

describe("requests", () => {
  it("separates a refusal from a failure", () => {
    const report = buildLogEventsReport({
      lines: [
        timing("public.booking.create", 201),
        timing("public.booking.create", 409),
        timing("public.booking.create", 500),
      ],
    });

    expect(report.requests["public.booking.create"]).toEqual({
      requests: 3,
      refused: 1,
      failed: 1,
    });
    // A 5xx on a booking route is not a normal outcome of anything.
    expect(report.criteria.find((row) => row.key === "no_server_errors")).toMatchObject({
      actual: 1,
      passed: false,
    });
  });

  it("does not report latency", () => {
    // `ops:booking-latency` owns the percentiles and Gate 7's targets. Two
    // tools computing one number is how they disagree during an incident.
    const report = buildLogEventsReport({ lines: [timing("public.availability")] });
    expect(JSON.stringify(report)).not.toContain("p95");
  });
});

describe("conflicts", () => {
  it("reads the conflict rate against mutation attempts", () => {
    const report = buildLogEventsReport({
      lines: [
        timing("public.booking.create", 409),
        timing("public.booking.create", 201),
        timing("staff.booking.reschedule", 409),
        timing("staff.booking.reschedule", 200),
        // Reads are not attempts to take a slot and are not in the denominator.
        timing("public.availability", 200),
        { event: "booking.slot_conflict", operation: "create" },
        { event: "booking.slot_conflict", operation: "reschedule" },
      ],
    });

    expect(report.booking).toMatchObject({
      slot_conflicts: 2,
      mutation_attempts: 4,
      conflict_rate: 0.5,
      conflicts_by_operation: { create: 1, reschedule: 1 },
    });
  });

  it("treats a constraint violation as a failed criterion", () => {
    // The exclusion constraint firing means the application check was raced or
    // bypassed. It held — and that is the last line of defence, not routine.
    const report = buildLogEventsReport({
      lines: [{ event: "booking.exclusion_violation", operation: "reschedule" }],
    });

    expect(report.booking.exclusion_violations).toBe(1);
    expect(report.criteria.find((row) => row.key === "no_exclusion_violations").passed).toBe(false);
    expect(report.verdict).toBe("NOT_READY");
  });

  it("has no conflict rate when nothing was attempted", () => {
    const report = buildLogEventsReport({ lines: [] });
    // Null, not zero: no attempts is not a perfect record.
    expect(report.booking.conflict_rate).toBeNull();
  });
});

describe("abuse and the dispatcher", () => {
  it("groups rate limits, challenges and cross-site refusals", () => {
    const report = buildLogEventsReport({
      lines: [
        { event: "rate_limit.exceeded", bucket: "public_booking.verify" },
        { event: "rate_limit.exceeded", bucket: "public_booking.verify" },
        { event: "rate_limit.exceeded", bucket: "public_booking.hold" },
        { event: "security.challenge_required", verdict: "missing" },
        { event: "security.challenge_required", verdict: "unsolved" },
        { event: "security.cross_site_refused" },
      ],
    });

    expect(report.abuse).toEqual({
      rate_limit_blocks: 3,
      rate_limit_by_bucket: { "public_booking.verify": 2, "public_booking.hold": 1 },
      challenges_required: 2,
      challenges_by_verdict: { missing: 1, unsolved: 1 },
      cross_site_refusals: 1,
    });
  });

  it("sums what the dispatcher did and fails on a job that could not run", () => {
    const report = buildLogEventsReport({
      lines: [
        { event: "notification.dispatched", claimed: 5, sent: 4, retried: 1, deadLettered: 0 },
        { event: "notification.dispatched", claimed: 2, sent: 1, retried: 0, deadLettered: 1 },
        { event: "notification.dead_letter", code: "no_destination" },
        { event: "notification.dispatch_failed", status: 502 },
      ],
    });

    expect(report.notifications).toMatchObject({
      claimed: 7,
      sent: 5,
      retried: 1,
      dead_lettered: 1,
      scheduler_failures: 1,
      dead_letters_by_code: { no_destination: 1 },
    });
    expect(report.criteria.find((row) => row.key === "no_scheduler_failures").passed).toBe(false);
  });
});

describe("reading a log stream", () => {
  it("keeps our lines, counts the rest and never repeats them", () => {
    const stream = [
      "app-1  | ready on :3000",
      `app-1  | ${JSON.stringify(timing("public.availability"))}`,
      "{ not json",
      JSON.stringify({ level: "info", message: "no event field" }),
      JSON.stringify({ event: "rate_limit.exceeded", bucket: "public_booking.hold" }),
      "",
    ].join("\n");

    const { lines, skipped } = parseLogLines(stream);

    // The prefixed line is ours with a collector's name in front of it.
    expect(lines.map((line) => line.event)).toEqual(["http.timing", "rate_limit.exceeded"]);
    expect(skipped).toBe(3);
  });

  it("reports the period the counts came from", () => {
    const report = buildLogEventsReport({
      lines: [
        { ...timing("public.availability"), timestamp: "2026-09-10T08:00:00.000Z" },
        { ...timing("public.availability"), timestamp: "2026-09-10T20:00:00.000Z" },
      ],
    });

    expect(report.window).toEqual({
      from: "2026-09-10T08:00:00.000Z",
      to: "2026-09-10T20:00:00.000Z",
    });
    expect(report.lines_read).toBe(2);
  });
});
