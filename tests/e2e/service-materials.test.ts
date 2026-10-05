import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { materialsCostingPeriods } from "@/db/schema";

import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * «Расходники на услугу» through the catalogue's own endpoints.
 *
 * What this holds to: the amount is kept as typed and null stays «not given»;
 * it costs nothing while the studio counts by purchases, and is taken off the
 * margin once its month is counted per service — the service's and its
 * add-ons' together. Nothing else of the costing moves.
 */

type Costed = {
  materials_minor: number | null;
  costing: { status: string; materials_minor: number; contribution_margin_minor: number; commission_minor: number };
};

let studio: Studio;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("materials@studio.example", "Materials Studio");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

/** A month already counted per service, so the answer does not depend on today's date. */
async function countPerService() {
  await adminDb.insert(materialsCostingPeriods).values({
    organizationId: studio.organizationId,
    mode: "per_service",
    effectiveFrom: "2020-01-01",
  });
}

describe("materials on a service", () => {
  test("are kept as typed, cost nothing while the studio counts by purchases, and clear back to null", async () => {
    const patched = dataOf<Costed>(
      await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, { materials_minor: 3_500 }),
    );
    expect(patched.materials_minor).toBe(3_500);
    expect(patched.costing).toMatchObject({
      materials_minor: 0,
      contribution_margin_minor: CANONICAL.contributionMarginMinor,
    });

    const cleared = dataOf<Costed>(
      await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, { materials_minor: null }),
    );
    expect(cleared.materials_minor).toBeNull();
  });

  test("refuses an amount below zero", async () => {
    const refused = await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, { materials_minor: -1 });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("VALIDATION_ERROR");
  });

  test("are taken off the margin, with the add-on's, once the month is counted per service", async () => {
    await countPerService();
    await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, { materials_minor: 3_500 });
    const addOn = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/add-ons", {
        name: { ru: "Снятие" },
        price_delta_minor: 10_000,
        materials_minor: 1_000,
      }),
    );

    const alone = dataOf<Costed>(await studio.owner.get(`/api/v1/services/${studio.serviceId}`));
    expect(alone.costing).toMatchObject({
      materials_minor: 3_500,
      commission_minor: CANONICAL.commissionMinor,
      contribution_margin_minor: CANONICAL.contributionMarginMinor - 3_500,
    });

    const withAddOn = dataOf<Costed>(
      await studio.owner.get(`/api/v1/services/${studio.serviceId}?add_on_ids=${addOn.id}`),
    );
    // 70 000 − 40% − (3 500 + 1 000).
    expect(withAddOn.costing).toMatchObject({ materials_minor: 4_500, contribution_margin_minor: 37_500 });

    // And the list costs every service the same way.
    const list = dataOf<(Costed & { id: string })[]>(await studio.owner.get("/api/v1/services"));
    expect(list.find((row) => row.id === studio.serviceId)?.costing.materials_minor).toBe(3_500);
  });
});

describe("materials on an add-on", () => {
  test("can be given to one created before them, and only by a catalogue manager", async () => {
    const addOn = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/add-ons", { name: { ru: "Дизайн" }, price_delta_minor: 5_000 }),
    );
    const listed = () =>
      studio.owner.get("/api/v1/add-ons").then((response) =>
        dataOf<{ id: string; materials_minor: number | null }[]>(response).find((row) => row.id === addOn.id),
      );
    expect((await listed())?.materials_minor).toBeNull();

    const saved = await studio.owner.patch(`/api/v1/add-ons/${addOn.id}`, { materials_minor: 2_000 });
    expect(saved.status).toBe(200);
    expect((await listed())?.materials_minor).toBe(2_000);

    const master = await inviteMember(studio.owner, "materials-master@studio.example", "master");
    expect((await master.patch(`/api/v1/add-ons/${addOn.id}`, { materials_minor: 0 })).status).toBe(403);
    expect((await listed())?.materials_minor).toBe(2_000);
  });

  test("of another studio is not found", async () => {
    const other = await createCanonicalStudio("materials-other@studio.example", "Other Studio");
    const theirs = dataOf<{ id: string }>(
      await other.owner.post("/api/v1/add-ons", { name: { ru: "Чужая" }, materials_minor: 500 }),
    );
    const refused = await studio.owner.patch(`/api/v1/add-ons/${theirs.id}`, { materials_minor: 0 });
    expect(refused.status).toBe(404);
    expect(errorCodeOf(refused)).toBe("ADD_ON_NOT_FOUND");
  });
});

describe("materials on a service a Master creates", () => {
  test("are refused, while the service itself can still be added without them", async () => {
    const master = await inviteMember(studio.owner, "materials-creator@studio.example", "master");
    const count = async () => dataOf<unknown[]>(await studio.owner.get("/api/v1/services")).length;
    const before = await count();

    const refused = await master.post("/api/v1/services", {
      name: { ru: "Френч" },
      price_minor: 40_000,
      duration_minutes: 60,
      materials_minor: 2_000,
    });
    expect(refused.status).toBe(403);
    expect(errorCodeOf(refused)).toBe("FORBIDDEN");
    expect(await count()).toBe(before);

    const added = await master.post("/api/v1/services", {
      name: { ru: "Френч" },
      price_minor: 40_000,
      duration_minutes: 60,
    });
    expect(added.status).toBe(201);
    expect(await count()).toBe(before + 1);
  });

  test("are a catalogue manager's to give at creation", async () => {
    const manager = await inviteMember(studio.owner, "materials-manager@studio.example", "manager");
    const created = await manager.post("/api/v1/services", {
      name: { ru: "Наращивание" },
      price_minor: 90_000,
      duration_minutes: 150,
      materials_minor: 8_000,
    });
    expect(created.status).toBe(201);
    const service = dataOf<{ id: string }>(created);
    expect(dataOf<{ materials_minor: number }>(await studio.owner.get(`/api/v1/services/${service.id}`)).materials_minor).toBe(8_000);
  });
});
