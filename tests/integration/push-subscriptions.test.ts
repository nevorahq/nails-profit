import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { forgetDevice, forgetPersonDevices, saveDevice } from "@/lib/push-subscriptions";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createOrganization, createUser } from "../helpers/factories";

/**
 * Through `@/db`, the application role, so the tenant policy is in force — a
 * device is an address that puts a studio's clients on a lock screen, and the
 * studio next door must not be able to read one, let alone send to it.
 */
afterAll(async () => {
  await closeTestConnections();
});

const device = (suffix: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
  userAgent: "test",
});

describe("push subscriptions", () => {
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    await resetDatabase();
    userA = (await createUser()).id;
    userB = (await createUser()).id;
    orgA = (await createOrganization({ name: "A", ownerId: userA })).id;
    orgB = (await createOrganization({ name: "B", ownerId: userB })).id;
  });

  it("shows a studio only its own devices", async () => {
    await withTenant(orgA, (tx) => saveDevice(tx, { organizationId: orgA, userId: userA, device: device("a") }));
    await withTenant(orgB, (tx) => saveDevice(tx, { organizationId: orgB, userId: userB, device: device("b") }));

    const seenByA = await withTenant(orgA, (tx) => tx.select().from(pushSubscriptions));
    expect(seenByA.map((row) => row.endpoint)).toEqual([device("a").endpoint]);
  });

  it("is invisible without a tenant context", async () => {
    await withTenant(orgA, (tx) => saveDevice(tx, { organizationId: orgA, userId: userA, device: device("a") }));
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  it("refuses to write a device into another studio", async () => {
    await expect(
      withTenant(orgA, (tx) =>
        tx.insert(pushSubscriptions).values({ organizationId: orgB, userId: userB, ...device("x") }),
      ),
    ).rejects.toThrow();
  });

  it("cannot delete another studio's device even by its endpoint", async () => {
    await withTenant(orgB, (tx) => saveDevice(tx, { organizationId: orgB, userId: userB, device: device("b") }));

    const removed = await withTenant(orgA, (tx) =>
      forgetDevice(tx, { userId: userB, endpoint: device("b").endpoint }),
    );
    expect(removed).toBe(0);
    expect(await adminDb.select().from(pushSubscriptions)).toHaveLength(1);
  });

  it("answers `taken` for an endpoint another studio holds, and leaves both transactions intact", async () => {
    await withTenant(orgB, (tx) => saveDevice(tx, { organizationId: orgB, userId: userB, device: device("shared") }));

    const outcome = await withTenant(orgA, async (tx) => {
      const result = await saveDevice(tx, { organizationId: orgA, userId: userA, device: device("shared") });
      // The savepoint is what keeps this transaction usable after the refusal.
      await saveDevice(tx, { organizationId: orgA, userId: userA, device: device("own") });
      return result;
    });

    expect(outcome).toBe("taken");
    const rows = await adminDb.select().from(pushSubscriptions);
    expect(rows.map((row) => [row.organizationId, row.endpoint]).sort()).toEqual(
      [
        [orgA, device("own").endpoint],
        [orgB, device("shared").endpoint],
      ].sort(),
    );
  });

  it("hands a device over within a studio, keeping one row", async () => {
    const colleague = (await createUser()).id;
    await withTenant(orgA, (tx) => saveDevice(tx, { organizationId: orgA, userId: userA, device: device("desk") }));
    await withTenant(orgA, (tx) =>
      saveDevice(tx, { organizationId: orgA, userId: colleague, device: device("desk") }),
    );

    const rows = await adminDb.select().from(pushSubscriptions);
    expect(rows.map((row) => row.userId)).toEqual([colleague]);
  });

  it("forgets every device of a person who leaves, and nobody else's", async () => {
    const colleague = (await createUser()).id;
    await withTenant(orgA, async (tx) => {
      await saveDevice(tx, { organizationId: orgA, userId: userA, device: device("phone") });
      await saveDevice(tx, { organizationId: orgA, userId: userA, device: device("laptop") });
      await saveDevice(tx, { organizationId: orgA, userId: colleague, device: device("theirs") });
    });

    await withTenant(orgA, (tx) => forgetPersonDevices(tx, { organizationId: orgA, userId: userA }));
    const rows = await adminDb.select().from(pushSubscriptions);
    expect(rows.map((row) => row.endpoint)).toEqual([device("theirs").endpoint]);
  });
});
