import { eq } from "drizzle-orm";
import webpush from "web-push";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { notificationOutbox, organizations, pushSubscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { dispatchDueNotifications } from "@/lib/notification-dispatch";
import { setNotificationProvider, type OutgoingMessage } from "@/lib/notification-provider";
import { createWebPushProvider } from "@/lib/push-provider";
import { forgetDeviceById, touchDevice } from "@/lib/push-subscriptions";
import { anonymous, dataOf, type Actor } from "../helpers/api";
import { wednesdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * A request reaching the phones of the people who turned push on, phase 7.
 *
 * Who hears is the bell's audience: the owner, who reads the whole calendar,
 * and the master whose chair it is — not the master at the next table, whose
 * phone would otherwise light up with a stranger's client.
 */
const vapid = webpush.generateVAPIDKeys();
const previous = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  flag: process.env.PUBLIC_BOOKING_ENABLED,
};

const CLIENT = { name: "Анна", phone: "+373 69 123 456", email: "anna@client.example" };

let studio: Studio;
let locationId: string;
let masterA: Actor;
let masterB: Actor;
let cardA: string;
let cardB: string;
let week = 0;
const sent: OutgoingMessage[] = [];

function device(name: string) {
  return {
    endpoint: `https://push.example.test/send/${name}`,
    keys: {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  };
}

async function bookableCard(name: string, userId: string) {
  const id = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/specialists", {
      name,
      cooperation_type: "commission",
      default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
    }),
  ).id;
  await studio.owner.patch(`/api/v1/specialists/${id}`, { user_id: userId });
  await studio.owner.put(`/api/v1/specialists/${id}/locations`, { location_ids: [locationId] });
  await studio.owner.put("/api/v1/availability/rules", {
    specialist_id: id,
    location_id: locationId,
    effective_from: "2026-08-01",
    intervals: [{ weekday: 3, start: "09:00", end: "18:00" }],
  });
  return id;
}

/** A public request for this card, on a Wednesday of its own. */
async function requestFor(specialistId: string) {
  week += 1;
  const { slots } = dataOf<{ slots: { starts_at: string; specialist_id: string }[] }>(
    await anonymous.get(
      `/api/v1/public/booking/push-studio/availability?location_id=${locationId}&service_id=${studio.serviceId}&specialist_id=${specialistId}&date=${wednesdayAhead(week)}`,
    ),
  );
  const slot = slots[0];
  expect(slot).toBeDefined();

  const held = dataOf<{ hold_token: string }>(
    await anonymous.post("/api/v1/public/booking/push-studio/holds", {
      location_id: locationId,
      service_id: studio.serviceId,
      add_on_ids: [],
      specialist_id: slot.specialist_id,
      starts_at: slot.starts_at,
    }),
  );

  return dataOf<{ id: string; status: string }>(
    await anonymous.post(
      "/api/v1/public/booking/push-studio/bookings",
      {
        hold_token: held.hold_token,
        service_id: studio.serviceId,
        add_on_ids: [],
        ...CLIENT,
        locale: "ru",
        legal_accepted: true,
      },
      { "idempotency-key": `push-${crypto.randomUUID()}` },
    ),
  );
}

function capture() {
  setNotificationProvider({
    name: "capture",
    async send(message) {
      sent.push(message);
      return { ok: true, providerMessageId: `capture:${sent.length}` };
    },
  });
}

beforeAll(async () => {
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.PUBLIC_BOOKING_ENABLED = "true";
  await resetDatabase();

  studio = await createCanonicalStudio("push-delivery-owner@studio.example", "Push Studio");
  await studio.owner.patch("/api/v1/organizations/settings", { slug: "push-studio" });
  await adminDb
    .update(organizations)
    .set({ bookingAccess: "public" })
    .where(eq(organizations.id, studio.organizationId));

  locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", {
      name: "Центр",
      slug: "centru",
      address: "str. Ismail 33",
      timezone: "Europe/Chisinau",
    }),
  ).id;
  await studio.owner.put(`/api/v1/locations/${locationId}/booking-settings`, {
    public_status: "published",
    confirmation_mode: "manual",
    min_lead_minutes: 0,
    max_advance_days: 90,
  });

  masterA = await inviteMember(studio.owner, "push-master-a@studio.example", "master");
  masterB = await inviteMember(studio.owner, "push-master-b@studio.example", "master");
  cardA = await bookableCard("Ирина", masterA.userId);
  cardB = await bookableCard("Мария", masterB.userId);
}, 90_000);

beforeEach(async () => {
  await adminDb.delete(notificationOutbox);
  await adminDb.delete(pushSubscriptions);
  await studio.owner.put("/api/v1/push/subscription", device("owner"));
  await masterA.put("/api/v1/push/subscription", device("master-a"));
  await masterB.put("/api/v1/push/subscription", device("master-b"));
});

afterEach(() => {
  setNotificationProvider(null);
  sent.length = 0;
});

afterAll(async () => {
  for (const [name, value] of [
    ["VAPID_PUBLIC_KEY", previous.publicKey],
    ["VAPID_PRIVATE_KEY", previous.privateKey],
    ["PUBLIC_BOOKING_ENABLED", previous.flag],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await closeTestConnections();
});

/**
 * The bell's one nudge. First in the file on purpose: its «before the first
 * request» half needs a chair nobody has booked yet.
 */
describe("the hint to turn push on", () => {
  async function hintFor(actor: Actor) {
    return dataOf<{ push_hint: boolean }>(await actor.get("/api/v1/notifications?locale=ru")).push_hint;
  }

  test("appears after the first online request on a chair the reader can see, until a device is on", async () => {
    await adminDb.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, masterB.userId));

    // Nothing to have missed yet.
    expect(await hintFor(masterB)).toBe(false);

    await requestFor(cardB);
    expect(await hintFor(masterB)).toBe(true);

    // The owner has a device on push already.
    expect(await hintFor(studio.owner)).toBe(false);

    await masterB.put("/api/v1/push/subscription", device("master-b"));
    expect(await hintFor(masterB)).toBe(false);
  });

  test("is not offered where push is not configured", async () => {
    await adminDb.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, masterB.userId));
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      expect(await hintFor(masterB)).toBe(false);
    } finally {
      process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
      process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    }
  });
});

describe("a request on the studio's phones", () => {
  test("reaches the owner and the master whose chair it is, and not her colleague", async () => {
    const booking = await requestFor(cardA);
    expect(booking.status).toBe("pending_confirmation");

    capture();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const pushes = sent.filter((message) => message.channel === "push");
    expect(pushes.map((message) => message.destination).sort()).toEqual(
      [device("master-a").endpoint, device("owner").endpoint].sort(),
    );
    expect(pushes.map((message) => message.destination)).not.toContain(device("master-b").endpoint);
  });

  test("says the time, the service and the name, never the phone or the email", async () => {
    await requestFor(cardB);
    capture();
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const pushes = sent.filter((message) => message.channel === "push");
    expect(pushes.length).toBeGreaterThan(0);
    for (const message of pushes) {
      const payload = JSON.parse(message.body) as { title: string; body: string; url: string };
      expect(payload.title).toBe("Новая заявка");
      expect(payload.body).toContain("Анна");
      expect(payload.body).toContain("Маникюр с покрытием");
      expect(payload.url).toMatch(/^\/app\/calendar\//);
      expect(message.body).not.toContain("69 123 456");
      expect(message.body).not.toContain("+37369123456");
      expect(message.body).not.toContain(CLIENT.email);
    }
    // The owner reads a chair that is not hers, so hers names it; the master's does not.
    const ownerPush = pushes.find((message) => message.destination === device("owner").endpoint)!;
    const masterPush = pushes.find((message) => message.destination === device("master-b").endpoint)!;
    expect(JSON.parse(ownerPush.body).body).toContain("Мария");
    expect(JSON.parse(masterPush.body).body).not.toContain("Мария");
  });

  test("is not sent once the request has been answered", async () => {
    const booking = await requestFor(cardA);
    expect((await studio.owner.post(`/api/v1/bookings/${booking.id}/confirm`, {})).status).toBe(200);

    capture();
    await dispatchDueNotifications({ organizationId: studio.organizationId });
    expect(sent.filter((message) => message.channel === "push" && message.subject === "Новая заявка")).toEqual([]);
  });

  test("forgets a device whose push service answers 410, and still reaches the rest", async () => {
    await requestFor(cardA);
    const gone = device("master-a").endpoint;
    setNotificationProvider(
      createWebPushProvider({
        vapid: { ...vapid, subject: "mailto:help@studio.example" },
        send: async (subscription) => {
          if (subscription.endpoint === gone) {
            throw Object.assign(new Error("Gone"), { statusCode: 410 });
          }
          sent.push({ channel: "push", destination: subscription.endpoint } as OutgoingMessage);
          return { statusCode: 201 };
        },
        forget: (organizationId, id) => withTenant(organizationId, (tx) => forgetDeviceById(tx, id)),
        touch: (organizationId, id) => withTenant(organizationId, (tx) => touchDevice(tx, id, new Date())),
      }),
    );
    await dispatchDueNotifications({ organizationId: studio.organizationId });

    const left = await adminDb.select().from(pushSubscriptions);
    expect(left.map((row) => row.endpoint)).not.toContain(gone);
    expect(left).toHaveLength(2);
    expect(sent.map((message) => message.destination)).toContain(device("owner").endpoint);

    const owners = left.find((row) => row.endpoint === device("owner").endpoint)!;
    expect(owners.lastSuccessAt).not.toBeNull();
  });

  test("queues nothing for a phone where push is not configured", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const booking = await requestFor(cardA);
      const queued = await adminDb
        .select({ channel: notificationOutbox.channel })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.bookingId, booking.id));
      expect(queued.map((row) => row.channel)).not.toContain("push");
      expect(queued.map((row) => row.channel)).toContain("email");
    } finally {
      process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
      process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    }
  });
});
