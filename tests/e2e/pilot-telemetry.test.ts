import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { pilotEnrollments, pilotProductEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

describe("Phase 6 product telemetry", () => {
  let studio: Studio;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("pilot-telemetry@example.test", "Pilot Telemetry");
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("records onboarding and the first trustworthy service calculation without PII", async () => {
    const events = await withTenant(studio.organizationId, (tx) =>
      tx.select().from(pilotProductEvents).orderBy(pilotProductEvents.occurredAt),
    );

    expect(events.map((event) => event.eventName)).toEqual([
      "onboarding_started",
      "service_cost_completed",
    ]);
    expect(events[1]).toMatchObject({
      eventVersion: 1,
      actorRole: "owner",
      source: "api",
      entityType: "service",
      entityId: studio.serviceId,
      metadata: { material_lines: 1 },
    });
    expect(JSON.stringify(events)).not.toMatch(/pilot-telemetry@|Маникюр|Мастер|База/);
  });

  test("deduplicates service completion and closes onboarding on a complete visit", async () => {
    await studio.owner.put(`/api/v1/services/${studio.serviceId}/recipe`, {
      items: [{ material_id: studio.materialId, quantity: 3.5 }],
    });
    await studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: studio.specialistId,
      actual_duration_minutes: 90,
    });

    const events = await withTenant(studio.organizationId, (tx) =>
      tx.select().from(pilotProductEvents).orderBy(pilotProductEvents.occurredAt),
    );
    expect(events.filter((event) => event.eventName === "service_cost_completed")).toHaveLength(1);
    expect(events.filter((event) => event.eventName === "visit_completed")).toHaveLength(1);
    expect(events.filter((event) => event.eventName === "onboarding_completed")).toHaveLength(1);
  });

  test("forced RLS hides telemetry from another organization", async () => {
    const other = await createCanonicalStudio("pilot-other@example.test", "Other Pilot");
    const visibleFromOther = await withTenant(other.organizationId, (tx) =>
      tx
        .select({ id: pilotProductEvents.id })
        .from(pilotProductEvents)
        .where(eq(pilotProductEvents.organizationId, studio.organizationId)),
    );

    expect(visibleFromOther).toEqual([]);
  });

  test("closed-pilot enforcement fails closed and honors active/paused rollout state", async () => {
    const previous = process.env.PILOT_ACCESS_ENFORCEMENT;
    process.env.PILOT_ACCESS_ENFORCEMENT = "true";
    try {
      expect((await studio.owner.get("/api/v1/services")).status).toBe(404);

      await adminDb.insert(pilotEnrollments).values({
        organizationId: studio.organizationId,
        wave: "demo",
        status: "active",
        operatorRef: "test-operator",
      });
      expect((await studio.owner.get("/api/v1/services")).status).toBe(200);

      await adminDb
        .update(pilotEnrollments)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(pilotEnrollments.organizationId, studio.organizationId));
      expect((await studio.owner.get("/api/v1/services")).status).toBe(404);
    } finally {
      if (previous === undefined) delete process.env.PILOT_ACCESS_ENFORCEMENT;
      else process.env.PILOT_ACCESS_ENFORCEMENT = previous;
    }
  });
});
