import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { users } from "@/db/schema";
import { signUp, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";

/**
 * There is no address confirmation, and this file exists to keep it that way.
 *
 * The letter used to go out at sign-up and a strip across the top of the app
 * offered to send it again. It gated nothing, and it could not do the one job
 * it claimed: the reset link goes to whatever address is on file whether or not
 * `emailVerified` is set, and the product has no way to change that address, so
 * the button could only re-send the same letter to the same mistyped inbox.
 *
 * What the tests below lock down is that registration is one step with no trip
 * to an inbox in it, and that `users.email_verified` — Better Auth's column,
 * still in the schema — sits at its `false` default without costing anybody
 * anything.
 */
let owner: Actor;

beforeAll(async () => {
  await resetDatabase();
  owner = await signUp("unverified-owner@studio.example");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("sign-up without address confirmation", () => {
  test("sends no confirmation letter", async () => {
    /*
     * Caught at the transport rather than in a table: the verification link was
     * a signed token with no row to look for, and what matters is that no
     * letter leaves. The development delivery printed it through `console.warn`,
     * so a `[verify-email]` line here would mean the mailer came back.
     */
    const printed = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await signUp("verify-watch@studio.example");
      const letters = printed.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("[verify-email]"));

      expect(letters).toEqual([]);
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
     * The part that must not regress. An unconfirmed address costs nothing at
     * all now: the studio is created, the catalogue is written and the first
     * visit closes, with nothing above the app asking for anything.
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
