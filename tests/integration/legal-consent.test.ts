import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { POST } from "@/app/api/auth/[...all]/route";
import { users } from "@/db/schema";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";

function signUp(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("versioned legal consent during sign-up", () => {
  beforeEach(resetDatabase);

  afterAll(async () => {
    await closeTestConnections();
  });

  test.each([
    ["missing", undefined],
    ["refused", false],
  ])("rejects sign-up when consent is %s", async (_label, legalAccepted) => {
    const response = await signUp({
      name: "Consent Test",
      email: `${_label}@example.test`,
      password: "orchid-lacquer-42-crown",
      ...(legalAccepted === undefined ? {} : { legalAccepted }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await adminDb.select().from(users)).toHaveLength(0);
  });

  test("stores trusted document versions and server timestamps", async () => {
    const email = "accepted@example.test";
    const response = await signUp({
      name: "Consent Test",
      email,
      password: "orchid-lacquer-42-crown",
      legalAccepted: true,
    });

    expect(response.status).toBe(200);

    const [user] = await adminDb.select().from(users).where(eq(users.email, email));
    expect(user).toMatchObject({
      legalAccepted: true,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });
    expect(user.termsAcceptedAt).toBeInstanceOf(Date);
    expect(user.privacyAcknowledgedAt).toBeInstanceOf(Date);
  });
});
