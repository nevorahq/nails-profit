import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, clients } from "@/db/schema";
import { dataOf, errorCodeOf, type Actor } from "../helpers/api";
import { isoDay, weekdayAhead } from "../helpers/calendar";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * The studio's note about a client, roadmap phase 8: written by the owner, a
 * manager and a master about their own clients; read by them in the same
 * scope; never by an Analyst, who reads clients without their contacts.
 */
type Card = { id: string; name: string; phone?: string | null; notes?: string | null };

let studio: Studio;
let manager: Actor;
let master: Actor;
let analyst: Actor;
/** Served by the master — theirs. */
let ownClientId: string;
/** Never served by the master — somebody else's. */
let foreignClientId: string;
let bookingId: string;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("notes-owner@studio.example", "Notes Studio");
  manager = await inviteMember(studio.owner, "notes-manager@studio.example", "manager");
  master = await inviteMember(studio.owner, "notes-master@studio.example", "master");
  analyst = await inviteMember(studio.owner, "notes-analyst@studio.example", "analyst");
  await studio.owner.patch(`/api/v1/specialists/${studio.specialistId}`, { user_id: master.userId });

  ownClientId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/clients", { name: "Своя", phone: "+37369100100" }),
  ).id;
  foreignClientId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/clients", { name: "Чужая", phone: "+37369200200" }),
  ).id;

  // The master's link to a client is a visit they performed.
  await studio.owner.post("/api/v1/visits", {
    service_id: studio.serviceId,
    specialist_id: studio.specialistId,
    client_id: ownClientId,
  });

  const locationId = dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/locations", { name: "Центр", slug: "notes-centru" }),
  ).id;
  await studio.owner.put(`/api/v1/specialists/${studio.specialistId}/locations`, {
    location_ids: [locationId],
  });
  bookingId = dataOf<{ id: string }>(
    await studio.owner.post(
      "/api/v1/bookings",
      {
        location_id: locationId,
        specialist_id: studio.specialistId,
        service_id: studio.serviceId,
        client_id: ownClientId,
        starts_at: `${isoDay(weekdayAhead(3, 1))}T08:00:00.000Z`,
      },
      { "idempotency-key": `notes-${crypto.randomUUID()}` },
    ),
  ).id;

  await studio.owner.patch(`/api/v1/clients/${ownClientId}`, { notes: "Аллергия на гель" });
  await studio.owner.patch(`/api/v1/clients/${foreignClientId}`, { notes: "Только по пятницам" });
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("who reads a client's note", () => {
  test("the owner and a manager read it on the card", async () => {
    for (const actor of [studio.owner, manager]) {
      expect(dataOf<Card>(await actor.get(`/api/v1/clients/${ownClientId}`)).notes).toBe("Аллергия на гель");
    }
  });

  test("a master reads the note of a client they served", async () => {
    const card = dataOf<Card>(await master.get(`/api/v1/clients/${ownClientId}`));
    expect(card.notes).toBe("Аллергия на гель");
  });

  test("a master does not see a client they never served, note and all", async () => {
    const response = await master.get(`/api/v1/clients/${foreignClientId}`);
    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("CLIENT_NOT_FOUND");
    expect(JSON.stringify(response.body)).not.toContain("Только по пятницам");
  });

  test("an analyst reads nobody's note, nor their number", async () => {
    for (const id of [ownClientId, foreignClientId]) {
      const card = dataOf<Card>(await analyst.get(`/api/v1/clients/${id}`));
      expect(card).not.toHaveProperty("notes");
      expect(card).not.toHaveProperty("phone");
    }

    const booking = dataOf<{ client: { notes: string | null; phone: string | null } }>(
      await analyst.get(`/api/v1/bookings/${bookingId}`),
    );
    expect(booking.client.notes).toBeNull();
    expect(booking.client.phone).toBeNull();
  });

  test("the appointment card carries it for the master whose appointment it is", async () => {
    const booking = dataOf<{ client: { notes: string | null } }>(await master.get(`/api/v1/bookings/${bookingId}`));
    expect(booking.client.notes).toBe("Аллергия на гель");
  });
});

describe("who writes it", () => {
  test("a master writes about their own client", async () => {
    const response = await master.patch(`/api/v1/clients/${ownClientId}`, { notes: "Миндаль, короткие" });
    expect(response.status).toBe(200);
    expect(dataOf<Card>(await studio.owner.get(`/api/v1/clients/${ownClientId}`)).notes).toBe("Миндаль, короткие");
  });

  test("a master cannot write about — or otherwise change — a client they never served", async () => {
    const noted = await master.patch(`/api/v1/clients/${foreignClientId}`, { notes: "перезаписано" });
    expect(noted.status).toBe(404);
    // Regression: the scope used to be the role's alone, so a master with an id
    // could rename or archive any client of the studio.
    const renamed = await master.patch(`/api/v1/clients/${foreignClientId}`, { name: "Чужая, переименованная" });
    expect(renamed.status).toBe(404);

    const [row] = await adminDb.select().from(clients).where(eq(clients.id, foreignClientId));
    expect(row.notes).toBe("Только по пятницам");
    expect(row.name).toBe("Чужая");
  });

  test("an analyst writes nothing", async () => {
    expect((await analyst.patch(`/api/v1/clients/${ownClientId}`, { notes: "x" })).status).toBe(403);
  });

  test("two thousand characters fit and one more does not", async () => {
    expect((await studio.owner.patch(`/api/v1/clients/${ownClientId}`, { notes: "а".repeat(2000) })).status).toBe(200);
    const tooLong = await studio.owner.patch(`/api/v1/clients/${ownClientId}`, { notes: "а".repeat(2001) });
    expect(tooLong.status).toBe(422);
    expect(errorCodeOf(tooLong)).toBe("VALIDATION_ERROR");
  });

  test("an empty note is no note", async () => {
    await studio.owner.patch(`/api/v1/clients/${ownClientId}`, { notes: "   " });
    const [row] = await adminDb.select().from(clients).where(eq(clients.id, ownClientId));
    expect(row.notes).toBeNull();
  });

  test("the note's words reach no audit event", async () => {
    await studio.owner.patch(`/api/v1/clients/${ownClientId}`, { notes: "секретное слово" });
    const events = await adminDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, studio.organizationId));
    expect(JSON.stringify(events)).not.toContain("секретное слово");
  });
});
