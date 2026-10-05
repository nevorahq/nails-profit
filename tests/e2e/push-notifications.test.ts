import { eq } from "drizzle-orm";
import webpush from "web-push";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { db } from "@/db";
import { memberships, pushSubscriptions, users } from "@/db/schema";
import { anonymous, dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * «Уведомления на этом устройстве», phase 7: the switch, as the API sees it.
 *
 * A device here is only what a browser hands over — an endpoint and two keys —
 * so the browser half is a fixture. What is under test is who may hold one, who
 * may see one, and when it is forgotten.
 */
const vapid = webpush.generateVAPIDKeys();
const previous = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

function device(name = crypto.randomUUID()) {
  return {
    endpoint: `https://push.example.test/send/${name}`,
    keys: {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  };
}

async function devicesOfUser(userId: string) {
  return adminDb.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
}

let studio: Studio;
let otherStudio: Studio;
let master: Actor;

beforeAll(async () => {
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  await resetDatabase();
  studio = await createCanonicalStudio("push-owner@studio.example");
  otherStudio = await createCanonicalStudio("push-other@studio.example", "Other Studio");
  master = await inviteMember(studio.owner, "push-master@studio.example", "master");
}, 60_000);

afterAll(async () => {
  process.env.VAPID_PUBLIC_KEY = previous.publicKey;
  process.env.VAPID_PRIVATE_KEY = previous.privateKey;
  await closeTestConnections();
});

beforeEach(async () => {
  await adminDb.delete(pushSubscriptions);
});

describe("the device switch", () => {
  test("says push exists and which key to subscribe with", async () => {
    const status = dataOf<{ enabled: boolean; public_key: string | null; devices: number }>(
      await master.get("/api/v1/push/subscription"),
    );
    expect(status).toEqual({ enabled: true, public_key: vapid.publicKey, devices: 0 });
  });

  test("says push is off where no keys are configured, and refuses a subscription", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const status = dataOf<{ enabled: boolean; public_key: string | null }>(
        await master.get("/api/v1/push/subscription"),
      );
      expect(status.enabled).toBe(false);
      expect(status.public_key).toBeNull();

      const refused = await master.put("/api/v1/push/subscription", device());
      expect(refused.status).toBe(503);
      expect(errorCodeOf(refused)).toBe("PUSH_DISABLED");
    } finally {
      process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
      process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    }
  });

  test("subscribes this device for this person in this studio, once", async () => {
    const phone = device("phone");
    expect((await master.put("/api/v1/push/subscription", phone)).status).toBe(200);
    // The switch re-sends on every draw; a second time is not a second device.
    expect((await master.put("/api/v1/push/subscription", phone)).status).toBe(200);

    const rows = await devicesOfUser(master.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(studio.organizationId);
    expect(rows[0].endpoint).toBe(phone.endpoint);

    expect(
      dataOf<{ devices: number }>(await master.get("/api/v1/push/subscription")).devices,
    ).toBe(1);
  });

  test("unsubscribes this device and leaves the person's others", async () => {
    const phone = device("phone");
    const laptop = device("laptop");
    await master.put("/api/v1/push/subscription", phone);
    await master.put("/api/v1/push/subscription", laptop);

    const response = await master.delete("/api/v1/push/subscription", { endpoint: phone.endpoint });
    expect(dataOf<{ removed: number }>(response).removed).toBe(1);
    expect((await devicesOfUser(master.userId)).map((row) => row.endpoint)).toEqual([laptop.endpoint]);

    // Again: already gone is the answer the caller wanted.
    const again = await master.delete("/api/v1/push/subscription", { endpoint: phone.endpoint });
    expect(dataOf<{ removed: number }>(again).removed).toBe(0);
  });

  test("cannot unsubscribe a colleague's device", async () => {
    const theirs = device("owner-phone");
    await studio.owner.put("/api/v1/push/subscription", theirs);

    await master.delete("/api/v1/push/subscription", { endpoint: theirs.endpoint });
    expect(await devicesOfUser(studio.owner.userId)).toHaveLength(1);
  });

  test("refuses a device another studio holds, so the browser can mint a new one", async () => {
    const shared = device("shared");
    await otherStudio.owner.put("/api/v1/push/subscription", shared);

    const response = await master.put("/api/v1/push/subscription", shared);
    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("PUSH_DEVICE_TAKEN");
    expect(await devicesOfUser(master.userId)).toHaveLength(0);
  });

  test("refuses anything that is not an https push endpoint with its keys", async () => {
    for (const body of [
      { ...device(), endpoint: "http://push.example.test/send/plain" },
      { ...device(), endpoint: "/api/v1/ops/notifications" },
      { endpoint: device().endpoint },
      { ...device(), keys: { p256dh: "not base64!", auth: "tBHItJI5svbpez7KI4CCXg" } },
    ]) {
      const response = await master.put("/api/v1/push/subscription", body);
      expect(response.status).toBe(422);
    }
  });

  test("asks for a session", async () => {
    expect((await anonymous.get("/api/v1/push/subscription")).status).toBe(401);
    expect((await anonymous.put("/api/v1/push/subscription", device())).status).toBe(401);
  });
});

describe("when a device is forgotten", () => {
  test("leaving the team forgets every device of that person", async () => {
    const leaving = await inviteMember(studio.owner, `leaving-${crypto.randomUUID()}@studio.example`, "master");
    await leaving.put("/api/v1/push/subscription", device());
    await leaving.put("/api/v1/push/subscription", device());
    await studio.owner.put("/api/v1/push/subscription", device());

    const [membership] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, leaving.userId));
    expect((await studio.owner.delete(`/api/v1/memberships/${membership.id}`)).status).toBe(200);

    expect(await devicesOfUser(leaving.userId)).toHaveLength(0);
    expect(await devicesOfUser(studio.owner.userId)).toHaveLength(1);
  });

  test("deleting the account takes its devices with it", async () => {
    const email = `deleted-${crypto.randomUUID()}@studio.example`;
    const leaving = await inviteMember(studio.owner, email, "master");
    await leaving.put("/api/v1/push/subscription", device());

    // A member's account, not an owner's: the route refuses an owner who still
    // has a studio. Nothing here forgets the device by hand — the account row's
    // foreign key does, through the tenant policy.
    const response = await leaving.post("/api/v1/account/delete", { confirmation_email: email });
    expect(response.status).toBe(200);

    expect(await adminDb.select().from(users).where(eq(users.id, leaving.userId))).toHaveLength(0);
    expect(await devicesOfUser(leaving.userId)).toHaveLength(0);
  });

  test("deleting the studio forgets every device in it, and none elsewhere", async () => {
    const doomed = await createCanonicalStudio(`doomed-${crypto.randomUUID()}@studio.example`, "Doomed Studio");
    await doomed.owner.put("/api/v1/push/subscription", device());
    await otherStudio.owner.put("/api/v1/push/subscription", device());

    const response = await doomed.owner.post("/api/v1/organizations/delete", {
      confirmation_name: "Doomed Studio",
    });
    expect(response.status).toBe(200);

    const left = await adminDb.select().from(pushSubscriptions);
    expect(left.map((row) => row.organizationId)).toEqual([otherStudio.organizationId]);
  });
});
