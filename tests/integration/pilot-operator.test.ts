import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createOrganization, createUser } from "../helpers/factories";

const runFile = promisify(execFile);

describe("pilot operator CLI", () => {
  let organizationId: string;
  let designPartnerId: string;

  beforeAll(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    const designPartnerOwner = await createUser("design-partner@example.test");
    designPartnerId = (await createOrganization({ ownerId: designPartnerOwner.id, name: "Design Partner" })).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  async function pilot(...args: string[]) {
    const { stdout } = await runFile(process.execPath, ["scripts/pilot.mjs", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PILOT_DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
        ALLOW_PILOT_OPERATOR_WRITE: "1",
      },
    });
    return JSON.parse(stdout);
  }

  test(
    "records commercial and support evidence and reports unresolved financial issues",
    async () => {
      const enrollment = await pilot(
        "enroll",
        "--organization",
        organizationId,
        "--wave",
        "demo",
        "--status",
        "active",
        "--operator",
        "test-operator",
        "--paid-at",
        "2026-05-01T12:00:00.000Z",
        "--monthly-price-minor",
        "60000",
        "--currency",
        "MDL",
      );
      expect(enrollment).toMatchObject({ organization_id: organizationId, status: "active" });

      await pilot(
        "interaction",
        "--organization",
        organizationId,
        "--kind",
        "onboarding",
        "--minutes",
        "90",
        "--operator",
        "test-operator",
      );
      await pilot(
        "interaction",
        "--organization",
        organizationId,
        "--kind",
        "decision",
        "--decision-type",
        "price",
        "--operator",
        "test-operator",
      );
      await pilot(
        "renewal",
        "--organization",
        organizationId,
        "--renewed",
        "true",
        "--operator",
        "test-operator",
      );
      const issue = await pilot(
        "issue",
        "--organization",
        organizationId,
        "--issue-code",
        "FIN-TEST-001",
        "--category",
        "financial",
        "--severity",
        "2",
        "--operator",
        "test-operator",
      );

      const blocked = await pilot(
        "report",
        "--at",
        "2026-08-05T12:00:00.000Z",
        "--support-capacity-minutes",
        "120",
      );
      expect(blocked).toMatchObject({
        verdict: "NOT_READY",
        metrics: {
          paid_organizations: 1,
          mrr_minor: 60_000,
          decision_organizations: 1,
          onboarding_average_minutes: 90,
          open_critical_financial_issues: 1,
        },
      });

      await pilot("resolve-issue", "--issue", issue.id, "--operator", "test-operator");
      const resolved = await pilot(
        "report",
        "--at",
        "2026-08-05T12:00:00.000Z",
        "--support-capacity-minutes",
        "120",
      );
      expect(resolved.metrics.open_critical_financial_issues).toBe(0);
    },
    30_000,
  );

  test("does not open the next rollout wave before review of the previous one", async () => {
    await expect(
      pilot(
        "enroll",
        "--organization",
        designPartnerId,
        "--wave",
        "design_partner",
        "--status",
        "active",
        "--operator",
        "test-operator",
      ),
    ).rejects.toThrow(/previous wave needs/i);

    await pilot(
      "interaction",
      "--organization",
      organizationId,
      "--kind",
      "profit_review",
      "--minutes",
      "30",
      "--operator",
      "test-operator",
    );
    const enrolled = await pilot(
      "enroll",
      "--organization",
      designPartnerId,
      "--wave",
      "design_partner",
      "--status",
      "active",
      "--operator",
      "test-operator",
    );
    expect(enrolled).toMatchObject({ organization_id: designPartnerId, wave: "design_partner" });
  });
});
