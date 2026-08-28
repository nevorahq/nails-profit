import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { users } from "@/db/schema";
import { signUp, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * Confirming the address, and what it deliberately does not do.
 *
 * The letter goes out at sign-up because the address is the only way back into
 * an account — `sendResetPassword` has nowhere else to send a recovery link. It
 * gates nothing: a studio registers and walks straight to its first calculated
 * visit without leaving for an inbox, which is the whole argument for keeping
 * `requireEmailVerification` off.
 */
let owner: Actor;

beforeAll(async () => {
  await resetDatabase();
  owner = await signUp("unverified-owner@studio.example");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("email verification", () => {
  test("sends the confirmation link at sign-up", async () => {
    /*
     * Caught at the transport rather than in a table: the pending verification
     * is a signed token, so there is no row to look for, and what matters is
     * that the letter left. In a test environment `resolveVerificationDelivery`
     * is the development one, which prints the link.
     */
    const printed = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await signUp("verify-watch@studio.example");
      const lines = printed.mock.calls.map((call) => String(call[0]));
      const letter = lines.find((line) => line.includes("[verify-email]"));

      expect(letter).toBeDefined();
      expect(letter).toContain("verify-watch@studio.example");
      expect(letter).toContain("/api/auth/verify-email");
    } finally {
      printed.mockRestore();
    }
  });

  test("leaves the account unverified and completely usable", async () => {
    const [account] = await adminDb
      .select({ verified: users.emailVerified })
      .from(users)
      .where(eq(users.email, "unverified-owner@studio.example"));

    expect(account.verified).toBe(false);

    /*
     * The part that must not regress. An unconfirmed address costs nothing but
     * a strip across the top: the studio is created, the catalogue is written
     * and the first visit closes, exactly as for a confirmed one.
     */
    expect(
      (await owner.post("/api/v1/organizations", {
        name: "Unverified Studio",
        type: "solo",
        currency: "MDL",
        locale: "ru",
      })).status,
    ).toBe(201);

    expect((await owner.get("/api/v1/onboarding")).status).toBe(200);
  });
});
