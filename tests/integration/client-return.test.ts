import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { bookings, clients } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadReturnList } from "@/lib/client-return";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createClient,
  createLocation,
  createOrganization,
  createSpecialist,
  createUser,
  createVisit,
} from "../helpers/factories";

/**
 * The query half of «Пора позвать»: which visits and appointments reach
 * `returnDue`. The rule itself is unit-tested in `domain/client-return.test.ts`;
 * this holds the reads to it — the archive and erasure, appointments still to
 * come, and a Master's narrowing — against PostgreSQL.
 */
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

describe("the clients worth inviting back", () => {
  let organizationId: string;
  let locationId: string;
  let irina: string;
  let olga: string;

  /** Three visits twenty days apart, the last thirty days ago: due by three days. */
  async function regular(name: string, lastWith: string) {
    const client = await createClient(organizationId, { name, normalizedPhone: null });
    await createVisit(organizationId, { specialistId: irina, clientId: client.id, completedAt: daysAgo(70) });
    await createVisit(organizationId, { specialistId: irina, clientId: client.id, completedAt: daysAgo(50) });
    await createVisit(organizationId, { specialistId: lastWith, clientId: client.id, completedAt: daysAgo(30) });
    return client.id;
  }

  function list(viewerSpecialistId: string | null = null) {
    return withTenant(organizationId, (tx) =>
      loadReturnList(tx, { timezone: "Europe/Chisinau", now: new Date(), viewerSpecialistId }),
    );
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    locationId = (await createLocation(organizationId)).id;
    irina = (await createSpecialist(organizationId)).id;
    olga = (await createSpecialist(organizationId)).id;
  });

  it("lists a client past their rhythm, with the rhythm", async () => {
    const id = await regular("Мария", irina);
    const rows = await list();
    expect(rows.map((row) => row.clientId)).toEqual([id]);
    expect(rows[0].due).toMatchObject({ intervalDays: 20, daysSinceLastVisit: 30, overdueDays: 10 });
  });

  it("leaves out a client with an appointment still to come, and keeps one whose appointment was cancelled", async () => {
    const coming = await regular("Записана", irina);
    const cancelled = await regular("Отменила", irina);
    const at = new Date(Date.now() + 3 * DAY);
    await adminDb.insert(bookings).values({
      organizationId,
      locationId,
      specialistId: irina,
      clientId: coming,
      startsAt: at,
      endsAt: new Date(at.getTime() + 60 * 60_000),
      status: "confirmed",
      source: "staff",
    });
    const later = new Date(at.getTime() + 2 * 60 * 60_000);
    await adminDb.insert(bookings).values({
      organizationId,
      locationId,
      specialistId: irina,
      clientId: cancelled,
      startsAt: later,
      endsAt: new Date(later.getTime() + 60 * 60_000),
      status: "cancelled",
      source: "staff",
      cancelledAt: new Date(),
      cancelledBy: "staff",
    });

    expect((await list()).map((row) => row.clientId)).toEqual([cancelled]);
  });

  it("leaves out archived and erased cards", async () => {
    const archived = await regular("В архиве", irina);
    const erased = await regular("Удалена", irina);
    await adminDb.update(clients).set({ archivedAt: new Date() }).where(eq(clients.id, archived));
    await adminDb
      .update(clients)
      .set({ anonymizedAt: new Date(), archivedAt: new Date() })
      .where(eq(clients.id, erased));

    expect(await list()).toEqual([]);
  });

  it("shows a master only the clients whose latest visit was theirs", async () => {
    const irinas = await regular("У Ирины", irina);
    const olgas = await regular("Перешла к Ольге", olga);

    expect((await list(irina)).map((row) => row.clientId)).toEqual([irinas]);
    expect((await list(olga)).map((row) => row.clientId)).toEqual([olgas]);
    expect((await list()).map((row) => row.clientId).sort()).toEqual([irinas, olgas].sort());
  });
});
