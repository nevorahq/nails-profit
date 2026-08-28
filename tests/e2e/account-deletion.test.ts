import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { eq } from "drizzle-orm";

import { financialSnapshots } from "@/db/schema";
import { dataOf, errorCodeOf, signIn, signUp, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { inviteMember } from "../helpers/studio";

/**
 * Leaving the product, which until this endpoint existed was impossible.
 *
 * Erasing a studio leaves the account behind on purpose — the owner may be
 * starting another one — but nothing could then remove the account itself. The
 * result was a pair of dead ends for anybody trying to start over: registration
 * answered «User already exists», while the old password still signed in and
 * landed on «создайте рабочее пространство». What is proved below is that the
 * two actions now compose: erase the studio, delete the account, register the
 * same address again.
 */
const PASSWORD = "test-password-123";

async function registerAgain(email: string) {
  const { auth } = await import("@/lib/auth");
  return auth.api.signUpEmail({
    body: { name: "Test", email, password: PASSWORD, legalAccepted: true },
    asResponse: true,
  });
}

let owner: Actor;
let visitId: string;

beforeAll(async () => {
  await resetDatabase();
  owner = await signUp("leaving-owner@studio.example");
  await owner.post("/api/v1/organizations", {
    name: "Leaving Studio",
    type: "solo",
    currency: "MDL",
    locale: "ru",
  });

  /*
   * A studio that actually traded, which is the case the first version of this
   * file missed: every closed visit writes a `financial_snapshot` stamped with
   * its author, and that column is what makes deleting the author hard. An
   * account that never closed anything deletes cleanly and proves nothing.
   */
  const specialistId = dataOf<{ id: string }>(
    await owner.post("/api/v1/specialists", {
      name: "Мастер",
      default_rule: { type: "percentage", basis_points: 4_000 },
    }),
  ).id;
  const serviceId = dataOf<{ id: string }>(
    await owner.post("/api/v1/services", {
      name: { ru: "Маникюр" },
      price_minor: 60_000,
      duration_minutes: 90,
    }),
  ).id;
  visitId = dataOf<{ id: string }>(
    await owner.post("/api/v1/visits", { service_id: serviceId, specialist_id: specialistId }),
  ).id;
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("deleting an account", () => {
  test("refuses to leave a live studio without an owner", async () => {
    const refused = await owner.post("/api/v1/account/delete", {
      confirmation_email: "leaving-owner@studio.example",
    });

    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe("ORGANIZATION_PRESENT");
  });

  test("needs the address typed back", async () => {
    const mistyped = await owner.post("/api/v1/account/delete", {
      confirmation_email: "someone-else@studio.example",
    });

    expect(mistyped.status).toBe(422);
    expect(errorCodeOf(mistyped)).toBe("CONFIRMATION_MISMATCH");
  });

  test("lets a member leave while the studio carries on", async () => {
    // A master owns nothing, so nothing is orphaned by their leaving.
    const master = await inviteMember(owner, "leaving-master@studio.example", "master");

    expect(
      (await master.post("/api/v1/account/delete", {
        confirmation_email: "leaving-master@studio.example",
      })).status,
    ).toBe(200);

    // The session died with the account: `session` cascades from `user`.
    expect((await master.get("/api/v1/services")).status).toBe(401);
    // And the studio is still there for its owner.
    expect((await owner.get("/api/v1/services")).status).toBe(200);
  });

  test("frees the address once the studio is gone", async () => {
    expect(
      (await owner.post("/api/v1/organizations/delete", { confirmation_name: "Leaving Studio" }))
        .status,
    ).toBe(200);

    expect(
      (await owner.post("/api/v1/account/delete", {
        confirmation_email: "leaving-owner@studio.example",
      })).status,
    ).toBe(200);

    // The old password no longer opens anything…
    await expect(signIn("leaving-owner@studio.example")).rejects.toThrow();

    // …and the address is free, which is what the whole journey was blocked on.
    expect((await registerAgain("leaving-owner@studio.example")).status).toBe(200);
  });

  test("keeps the books the leaver wrote, minus their name", async () => {
    /*
     * The regression this file exists for, and the one it originally missed.
     *
     * `financial_snapshot.created_by` is ON DELETE SET NULL, and the table
     * refuses UPDATE — so deleting an author asked the database to do the one
     * thing it forbids, and every account that had closed a visit failed to
     * delete with a bare 500. Migration 0043 allows exactly this update and no
     * other: the author becomes nobody, the figures stay put.
     */
    const [snapshot] = await adminDb
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, visitId));

    expect(snapshot).toBeDefined();
    expect(snapshot.createdBy).toBeNull();
    expect(snapshot.revenueMinor).toBe(60_000);
  });
});
