import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  auditEvents,
  bookingAccessTokens,
  bookingLines,
  bookings,
  clients,
  financialSnapshots,
  notificationOutbox,
  visits,
} from "@/db/schema";
import { dataOf, type Actor } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

describe("single-client privacy erasure", () => {
  let studio: Studio;
  let otherStudio: Studio;
  let manager: Actor;
  let clientId: string;
  let bookingId: string;
  let clientVersionBeforeErasure: number;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("client-erasure-owner@example.test", "Erasure Studio");
    otherStudio = await createCanonicalStudio("client-erasure-other@example.test", "Other Studio");
    manager = await inviteMember(studio.owner, "client-erasure-manager@example.test", "manager");

    clientId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/clients", {
        name: "Erasure Client",
        phone: "+37369000777",
        email: "erasure-client@example.test",
      }),
    ).id;

    // A public booking normally writes this consent metadata. Setting it here
    // keeps this scenario focused on erasure while proving that the fields are
    // not left attached to the retained pseudonymous row.
    const [withConsent] = await adminDb
      .update(clients)
      .set({
        locale: "ro",
        termsVersion: "2026-08-01",
        privacyVersion: "2026-08-01",
        consentedAt: new Date("2026-08-01T12:00:00.000Z"),
      })
      .where(eq(clients.id, clientId))
      .returning({ version: clients.version });
    clientVersionBeforeErasure = withConsent.version;

    await studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: studio.specialistId,
      client_id: clientId,
      actual_duration_minutes: 90,
    });

    const locationId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Privacy room", slug: "erasure-studio" }),
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
          client_id: clientId,
          starts_at: "2026-10-14T09:00:00.000Z",
        },
        { "idempotency-key": `client-erasure-${crypto.randomUUID()}` },
      ),
    ).id;

    // A manage token and queued messages are privacy-relevant live access,
    // unlike the retained booking/visit history.
    expect((await studio.owner.post(`/api/v1/bookings/${bookingId}/manage-link`, {})).status).toBe(200);
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("another organization cannot discover or erase the client", async () => {
    const response = await otherStudio.owner.delete(`/api/v1/clients/${clientId}`);
    expect(response.status).toBe(404);

    const [unchanged] = await adminDb.select().from(clients).where(eq(clients.id, clientId));
    expect(unchanged.normalizedPhone).toBe("+37369000777");
    expect(unchanged.anonymizedAt).toBeNull();
  });

  test("erasure removes PII and live access while preserving financial history", async () => {
    const response = await manager.delete(`/api/v1/clients/${clientId}`);
    expect(response.status).toBe(200);
    expect(dataOf(response)).toMatchObject({
      id: clientId,
      anonymized: true,
      already_anonymized: false,
    });

    const [client] = await adminDb.select().from(clients).where(eq(clients.id, clientId));
    const visitRows = await adminDb.select().from(visits).where(eq(visits.clientId, clientId));
    const snapshotRows = await adminDb
      .select()
      .from(financialSnapshots)
      .where(inArray(financialSnapshots.visitId, visitRows.map((visit) => visit.id)));
    const bookingRows = await adminDb.select().from(bookings).where(eq(bookings.clientId, clientId));
    const lineRows = await adminDb.select().from(bookingLines).where(eq(bookingLines.bookingId, bookingId));
    const tokenRows = await adminDb
      .select()
      .from(bookingAccessTokens)
      .where(eq(bookingAccessTokens.bookingId, bookingId));
    const queuedRows = await adminDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.bookingId, bookingId),
          inArray(notificationOutbox.status, ["pending", "retry"]),
        ),
      );
    const erasureEvents = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, clientId), eq(auditEvents.eventType, "client.anonymized")));

    expect(client).toMatchObject({
      name: "Deleted client",
      normalizedPhone: null,
      email: null,
      locale: null,
      termsVersion: null,
      privacyVersion: null,
      consentedAt: null,
    });
    expect(client.anonymizedAt).toBeInstanceOf(Date);
    expect(client.archivedAt).toBeInstanceOf(Date);
    expect(client.version).toBe(clientVersionBeforeErasure + 1);

    expect(visitRows).toHaveLength(1);
    expect(snapshotRows).toHaveLength(1);
    expect(bookingRows).toHaveLength(1);
    expect(bookingRows[0].id).toBe(bookingId);
    expect(lineRows.length).toBeGreaterThan(0);

    expect(tokenRows.length).toBeGreaterThan(0);
    expect(tokenRows.every((token) => token.revokedAt instanceof Date)).toBe(true);
    expect(queuedRows).toHaveLength(0);

    expect(erasureEvents).toHaveLength(1);
    expect(erasureEvents[0].before).toBeNull();
    expect(erasureEvents[0].after).toEqual(
      expect.objectContaining({ bookings_preserved: 1, access_tokens_revoked: tokenRows.length }),
    );
    expect(JSON.stringify(erasureEvents)).not.toMatch(
      /Erasure Client|69000777|erasure-client@example\.test/,
    );

    const visibleClients = dataOf<{ id: string }[]>(await manager.get("/api/v1/clients"));
    expect(visibleClients.map((candidate) => candidate.id)).not.toContain(clientId);
  });

  test("retry is idempotent and does not duplicate the audit event", async () => {
    const response = await manager.delete(`/api/v1/clients/${clientId}`);
    expect(response.status).toBe(200);
    expect(dataOf(response)).toMatchObject({ already_anonymized: true });

    const [client] = await adminDb.select().from(clients).where(eq(clients.id, clientId));
    expect(client.version).toBe(clientVersionBeforeErasure + 1);

    const events = await adminDb
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, clientId), eq(auditEvents.eventType, "client.anonymized")));
    expect(events).toHaveLength(1);
  });
});
