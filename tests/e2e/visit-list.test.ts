import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { measureStatements } from "@/db/query-meter";
import { withTenant } from "@/db/tenant";
import { loadVisitList } from "@/lib/visit-list";

import { dataOf } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The visits page's data: right, and read in a number of statements that does
 * not grow with the visits.
 *
 * It grew with them once — a snapshot, the lines and the client's name each
 * read with a statement of their own for every visit — and a studio with sixty
 * visits waited half a minute for the list when the database is an ocean away.
 * Every test written against ten rows passed throughout, which is why the count
 * is asserted here and not left to timing.
 */
let studio: Studio;
let clientIds: string[];

async function closeVisit(clientId: string | null) {
  return dataOf<{ id: string }>(
    await studio.owner.post("/api/v1/visits", {
      specialist_id: studio.specialistId,
      service_id: studio.serviceId,
      ...(clientId ? { client_id: clientId } : {}),
    }),
  ).id;
}

function load() {
  return measureStatements(() =>
    withTenant(studio.organizationId, (tx) =>
      loadVisitList(tx, { userId: studio.owner.userId, role: "owner" }, { onlyVisit: null }, false),
    ),
  );
}

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("visit-list-owner@example.com", "Visit List Studio");
  clientIds = [];
  for (const name of ["Anna Client", "Boris Client", "Clara Client"]) {
    clientIds.push(dataOf<{ id: string }>(await studio.owner.post("/api/v1/clients", { name })).id);
  }
});

afterAll(async () => {
  await closeTestConnections();
});

describe("the visit list", () => {
  test("is empty, and cheap, when there are no visits", async () => {
    const { result, statements } = await load();

    expect(result.detailed).toEqual([]);
    expect(result.people.map((person) => person.name)).toContain("Мастер");
    // The transaction's setup, the visits and the people; nothing is asked
    // about visits that are not there.
    expect(statements.length).toBeLessThanOrEqual(3);
  });

  test("pairs every visit with its own newest snapshot, its own lines and its own client", async () => {
    const first = await closeVisit(clientIds[0]);
    const second = await closeVisit(clientIds[1]);
    const withoutClient = await closeVisit(null);
    // A correction makes a second snapshot for one visit only.
    expect(
      (await studio.owner.post(`/api/v1/visits/${second}/adjust`, { tip_minor: 500, reason: "Чаевые" })).status,
    ).toBe(201);

    const { result } = await load();
    const byId = new Map(result.detailed.map((row) => [row.visit.id, row]));

    expect(byId.size).toBe(3);
    expect(byId.get(first)).toMatchObject({ clientName: "Anna Client", snapshot: { snapshotVersion: 1 } });
    expect(byId.get(second)).toMatchObject({ clientName: "Boris Client", snapshot: { snapshotVersion: 2 } });
    expect(byId.get(withoutClient)).toMatchObject({ clientName: null, snapshot: { snapshotVersion: 1 } });
    for (const row of result.detailed) {
      expect(row.snapshot?.visitId).toBe(row.visit.id);
      expect(row.lines.length).toBeGreaterThan(0);
      expect(row.lines.every((line) => line.visitId === row.visit.id)).toBe(true);
    }
  });

  test("lists the newest visit first", async () => {
    const { result } = await load();
    const times = result.detailed.map((row) => row.visit.completedAt.getTime());

    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test("sends the same statements for twelve visits as for three", async () => {
    const few = await load();
    for (let visit = 0; visit < 9; visit += 1) await closeVisit(clientIds[visit % clientIds.length]);

    const many = await load();

    expect(few.result.detailed).toHaveLength(3);
    expect(many.result.detailed).toHaveLength(12);
    expect(many.statements.length).toBe(few.statements.length);
    // setup, visits with their clients, the people, the newest snapshots, the lines.
    expect(many.statements.length).toBeLessThanOrEqual(5);
  });
});
