import { describe, expect, test } from "vitest";

import { buildPilotGateReport, parsePilotArgs } from "./pilot-core.mjs";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const OLD = "2026-05-01T12:00:00.000Z";

function passingInput() {
  const enrollments = Array.from({ length: 10 }, (_, index) => ({
    organization_id: `organization-${index}`,
    paid_at: OLD,
    monthly_price_minor: 60_000,
    renewed_second_month: index < 6,
    enrolled_at: OLD,
  }));
  const events = [];
  const interactions = [];

  for (let index = 0; index < 10; index += 1) {
    const organizationId = `organization-${index}`;
    events.push({
      organization_id: organizationId,
      event_name: "onboarding_started",
      entity_id: organizationId,
      occurred_at: OLD,
    });
    if (index < 7) {
      events.push({
        organization_id: organizationId,
        event_name: "onboarding_completed",
        entity_id: organizationId,
        occurred_at: "2026-05-02T12:00:00.000Z",
      });
      for (let service = 0; service < 5; service += 1) {
        events.push({
          organization_id: organizationId,
          event_name: "service_cost_completed",
          entity_id: `service-${service}`,
          occurred_at: "2026-05-03T12:00:00.000Z",
        });
      }
    }
    if (index < 6) {
      events.push({
        organization_id: organizationId,
        event_name: "visit_completed",
        entity_id: `visit-${index}`,
        occurred_at: "2026-08-04T12:00:00.000Z",
      });
      interactions.push({
        organization_id: organizationId,
        kind: "decision",
        duration_minutes: null,
        decision_type: "price",
        occurred_at: "2026-08-04T12:00:00.000Z",
      });
    }
    interactions.push(
      {
        organization_id: organizationId,
        kind: "onboarding",
        duration_minutes: 90,
        decision_type: null,
        occurred_at: "2026-05-01T12:00:00.000Z",
      },
      {
        organization_id: organizationId,
        kind: "support",
        duration_minutes: 10,
        decision_type: null,
        occurred_at: "2026-08-04T12:00:00.000Z",
      },
    );
  }

  return { enrollments, events, interactions, issues: [] };
}

describe("Gate 6 report", () => {
  test("passes only when every commercial, product and operating criterion passes", () => {
    const report = buildPilotGateReport({
      ...passingInput(),
      now: NOW,
      supportCapacityMinutes: 120,
    });

    expect(report.verdict).toBe("PASS");
    expect(report.metrics).toMatchObject({
      paid_organizations: 10,
      mrr_minor: 600_000,
      activation_rate: 0.7,
      five_service_organizations: 7,
      decision_organizations: 6,
      renewal_rate: 0.6,
      weekly_active_rate: 0.6,
      onboarding_average_minutes: 90,
      support_minutes_last_30_days: 100,
    });
    expect(report.criteria.every((row) => row.passed)).toBe(true);
  });

  test("missing measurements are NOT_READY rather than silently treated as zero", () => {
    const input = passingInput();
    input.interactions = input.interactions.filter((row) => row.kind !== "onboarding");
    const report = buildPilotGateReport({ ...input, now: NOW, supportCapacityMinutes: null });

    expect(report.verdict).toBe("NOT_READY");
    expect(report.criteria.find((row) => row.key === "onboarding")).toMatchObject({
      passed: false,
      actual: null,
      coverage: "0/10 measured",
    });
    expect(report.criteria.find((row) => row.key === "support_capacity")).toMatchObject({
      passed: false,
      target: "capacity input required",
    });
  });

  test("an open Severity 1-2 financial discrepancy blocks the gate", () => {
    const input = passingInput();
    const report = buildPilotGateReport({
      ...input,
      issues: [
        {
          organization_id: "organization-0",
          category: "financial",
          severity: 2,
          status: "open",
        },
      ],
      now: NOW,
      supportCapacityMinutes: 120,
    });

    expect(report.verdict).toBe("NOT_READY");
    expect(report.criteria.find((row) => row.key === "financial_consistency")).toMatchObject({
      actual: 1,
      passed: false,
    });
  });
});

describe("pilot CLI arguments", () => {
  test("parses kebab-case flags into stable keys", () => {
    expect(
      parsePilotArgs([
        "interaction",
        "--organization",
        "org-id",
        "--decision-type",
        "price",
      ]),
    ).toEqual({
      command: "interaction",
      values: { organization: "org-id", decision_type: "price" },
    });
  });

  test("rejects a flag without a value", () => {
    expect(() => parsePilotArgs(["report", "--at"])).toThrow("Missing value");
  });
});
