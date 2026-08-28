import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, commissionRules, specialistLocations, specialists } from "@/db/schema";
import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * Removing a master, and refusing to.
 *
 * Two words in the interface, two different things underneath. A master who
 * never worked is a typo and goes for good. A master who has visits is payroll:
 * their commission is inside every financial snapshot those visits wrote, and
 * `visit.specialist_id` is `ON DELETE restrict` precisely so that this decision
 * cannot be taken by a cascade.
 */
describe("deleting a specialist", () => {
  let studio: Studio;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("owner@specialist.example", "Specialist Studio");
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  async function newSpecialist(name: string) {
    return dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name, cooperation_type: "commission" }),
    ).id;
  }

  test("removes a master who never worked, and their configuration with them", async () => {
    const id = await newSpecialist("Ошибка ввода");

    const location = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/locations", { name: "Зал", slug: `hall-${Date.now()}` }),
    ).id;
    await studio.owner.put(`/api/v1/specialists/${id}/locations`, { location_ids: [location] });
    await studio.owner.post(`/api/v1/specialists/${id}/commission-rules`, {
      type: "percentage",
      basis_points: 4_000,
    });

    const response = await studio.owner.delete<{ id: string; removed: string }>(
      `/api/v1/specialists/${id}`,
    );

    expect(response.status).toBe(200);
    expect(dataOf<{ removed: string }>(response).removed).toBe("deleted");

    expect(await adminDb.select().from(specialists).where(eq(specialists.id, id))).toHaveLength(0);
    expect(
      await adminDb.select().from(specialistLocations).where(eq(specialistLocations.specialistId, id)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(commissionRules).where(eq(commissionRules.specialistId, id)),
    ).toHaveLength(0);
  });

  test("leaves the deleted master readable in the audit trail", async () => {
    const id = await newSpecialist("Уходит в лог");
    await studio.owner.delete(`/api/v1/specialists/${id}`);

    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, id), eq(auditEvents.eventType, "specialist.deleted")));

    // The row exists nowhere else now, so the event has to say who it was.
    expect((event.before as { name: string }).name).toBe("Уходит в лог");
  });

  test("archives a master who has visits instead of deleting them", async () => {
    // The canonical studio is set up but has recorded nothing; the visit is
    // what turns this master from a catalogue row into payroll.
    await studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: studio.specialistId,
      completed_at: new Date().toISOString(),
      actual_duration_minutes: 90,
    });

    const response = await studio.owner.delete(`/api/v1/specialists/${studio.specialistId}`);

    expect(response.status).toBe(200);
    expect(dataOf<{ removed: string }>(response).removed).toBe("archived");

    const [row] = await adminDb
      .select()
      .from(specialists)
      .where(eq(specialists.id, studio.specialistId));

    // Still there, and still attached to the visits that paid them.
    expect(row).toBeDefined();
    expect(row.archivedAt).not.toBeNull();
  });

  test("refuses while an account is still linked", async () => {
    const id = await newSpecialist("С аккаунтом");
    await studio.owner.patch(`/api/v1/specialists/${id}`, { user_id: studio.owner.userId });

    const response = await studio.owner.delete(`/api/v1/specialists/${id}`);

    expect(response.status).toBe(409);
    expect(errorCodeOf(response)).toBe("SPECIALIST_HAS_ACCOUNT");
    expect(await adminDb.select().from(specialists).where(eq(specialists.id, id))).toHaveLength(1);

    // Unlinking is the first of the two steps the interface asks for; the
    // second one then works.
    await studio.owner.patch(`/api/v1/specialists/${id}`, { user_id: null });
    expect((await studio.owner.delete(`/api/v1/specialists/${id}`)).status).toBe(200);
    expect(await adminDb.select().from(specialists).where(eq(specialists.id, id))).toHaveLength(0);
  });

  test("answers 404 for a master that does not exist", async () => {
    const response = await studio.owner.delete(
      "/api/v1/specialists/00000000-0000-4000-8000-000000000000",
    );

    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("SPECIALIST_NOT_FOUND");
  });
});
