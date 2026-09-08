import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { dataOf, signUp } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * A registration is a lead, and this is the test that somebody hears about it.
 *
 * Caught at the transport rather than in a table: outside production the notice
 * prints instead of mailing (`lib/studio-lead-notice.ts`), so a `[studio-lead]`
 * line is exactly as much evidence as an outbox row would be, and it stays true
 * whichever provider a deployment ends up configured with.
 *
 * The second test is the half that is easy to lose. What is announced is a
 * *studio*, not an account: a master joining an existing studio by invitation
 * creates a user and no organization, and an operator mailed about every one of
 * those learns nothing and stops reading the ones that matter.
 */
beforeAll(async () => {
  await resetDatabase();
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

async function linesWhile(action: () => Promise<void>): Promise<string[]> {
  const printed = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await action();
    return printed.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("[studio-lead]"));
  } finally {
    printed.mockRestore();
  }
}

describe("a studio that registers", () => {
  test("is announced with what a first conversation needs", async () => {
    let organizationId = "";

    const lines = await linesWhile(async () => {
      const owner = await signUp("lead-owner@studio.example");
      organizationId = dataOf<{ id: string }>(
        await owner.post("/api/v1/organizations", {
          name: "Lead Studio",
          type: "studio",
          currency: "MDL",
          locale: "ru",
        }),
      ).id;
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Lead Studio");
    expect(lines[0]).toContain("studio");
    expect(lines[0]).toContain("MDL");
    expect(lines[0]).toContain("lead-owner@studio.example");
    expect(lines[0]).toContain(organizationId);
  });

  test("registers even when the announcement cannot be delivered", async () => {
    /*
     * The transport is the one part of this that talks to the outside world,
     * and the studio must not depend on it. Outside production that transport
     * is `console.warn`, so refusing exactly the notice's own line — and
     * nothing else the request happens to print — is a delivery failure
     * arriving in the shape a refused send would: a throw, on the way out of a
     * committed registration.
     */
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusing = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes("[studio-lead]")) throw new Error("transport unreachable");
    });

    try {
      const owner = await signUp("lead-undeliverable@studio.example");
      const response = await owner.post("/api/v1/organizations", {
        name: "Undeliverable Studio",
        type: "solo",
        currency: "MDL",
        locale: "ru",
      });

      expect(response.status).toBe(201);
      expect(dataOf<{ id: string }>(response).id).toBeTruthy();
      // Nothing is thrown at the registrant, and the failure is on the record.
      expect(
        printed.mock.calls.some((call) => String(call[0]).includes("studio_lead.announce_failed")),
      ).toBe(true);
    } finally {
      refusing.mockRestore();
      printed.mockRestore();
    }
  });
});

describe("an account with no studio of its own", () => {
  test("is not announced as a lead", async () => {
    const lines = await linesWhile(async () => {
      // Exactly what an invited master does: an account, and no organization.
      await signUp("lead-master@studio.example");
    });

    expect(lines).toEqual([]);
  });
});
