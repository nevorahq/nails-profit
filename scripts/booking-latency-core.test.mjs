import { describe, expect, test } from "vitest";

import { buildBookingLatencyReport } from "./booking-latency-core.mjs";

function timing(route, duration_ms, status = 200) {
  return { event: "http.timing", route, duration_ms, status };
}

describe("booking latency report", () => {
  test("passes both Gate 7 latency targets with enough fleet samples", () => {
    const records = [
      ...Array.from({ length: 30 }, (_, index) => timing("public.availability", 100 + index)),
      ...Array.from({ length: 10 }, () => timing("public.booking.create", 350)),
      ...Array.from({ length: 10 }, () => timing("public.booking.reschedule", 420)),
      ...Array.from({ length: 10 }, () => timing("staff.booking.create", 390)),
    ];

    const report = buildBookingLatencyReport(records);

    expect(report.verdict).toBe("PASS");
    expect(report.criteria).toEqual([
      expect.objectContaining({ key: "availability", p95_ms: 128, passed: true }),
      expect.objectContaining({ key: "booking_mutation", p95_ms: 420, passed: true }),
    ]);
  });

  test("does not turn a small fast sample into pilot evidence", () => {
    const report = buildBookingLatencyReport([
      timing("public.availability", 50),
      timing("public.booking.create", 70),
    ]);

    expect(report.verdict).toBe("NOT_READY");
    expect(report.criteria.every((criterion) => criterion.passed === false)).toBe(true);
  });

  test("fails when the nearest-rank p95 crosses a target", () => {
    const records = [
      ...Array.from({ length: 28 }, () => timing("public.availability", 200)),
      timing("public.availability", 700),
      timing("public.availability", 900),
      ...Array.from({ length: 30 }, () => timing("public.booking.create", 300)),
    ];

    const report = buildBookingLatencyReport(records);

    expect(report.criteria.find((criterion) => criterion.key === "availability")).toMatchObject({
      p95_ms: 700,
      passed: false,
    });
    expect(report.routes["public.availability"].max_ms).toBe(900);
    expect(report.verdict).toBe("NOT_READY");
  });

  test("ignores unrelated, malformed and incomplete log records", () => {
    const report = buildBookingLatencyReport(
      [
        null,
        { event: "request.error", route: "public.availability", duration_ms: 10, status: 500 },
        { event: "http.timing", route: "unknown", duration_ms: 10, status: 200 },
        { event: "http.timing", route: "public.availability", duration_ms: -1, status: 200 },
        timing("public.availability", 100),
        timing("public.booking.cancel", 200),
      ],
      { minSamples: 1 },
    );

    expect(report.accepted_samples).toBe(2);
    expect(report.verdict).toBe("PASS");
  });
});
