import { beforeEach, describe, expect, it } from "vitest";

import { expenses } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadMaterialsHint } from "@/lib/materials-hint";
import { recordCompletedVisit } from "@/lib/visit-service";

import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * «По вашим закупкам ≈ X на визит» from real rows: three full months before
 * the one asked about, in the studio's own zone, and nothing below twenty
 * visits.
 */
describe("the materials hint from purchases", () => {
  let userId: string;
  let organizationId: string;
  let specialistId: string;
  let serviceId: string;

  // October in Chișinău: the hint reads July, August and September.
  const AT = new Date("2026-10-15T12:00:00.000Z");

  async function closeVisits(count: number, from: Date) {
    for (let index = 0; index < count; index += 1) {
      await withTenant(organizationId, async (tx) => {
        const result = await recordCompletedVisit(tx, {
          organizationId,
          actor: { userId, role: "owner" },
          serviceId,
          specialistId,
          clientId: null,
          addOnIds: [],
          completedAt: new Date(from.getTime() + index * 60 * 60_000),
          actualDurationMinutes: 60,
          requestId: "test",
        });
        if (!result.ok) throw new Error(`visit refused: ${result.failure}`);
      });
    }
  }

  const hint = () =>
    withTenant(organizationId, (tx) => loadMaterialsHint(tx, { organizationId, currency: "MDL", at: AT }));

  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
    organizationId = (await createOrganization({ ownerId: userId })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: new Date("2025-01-01T00:00:00.000Z"),
    });
    serviceId = (await createService(organizationId, { priceMinor: 30_000, durationMinutes: 60 })).id;
    await adminDb.insert(expenses).values([
      { organizationId, name: "Гель", category: "materials", spentOn: "2026-07-10", amountMinor: 60_000, currency: "MDL" },
      { organizationId, name: "Перчатки", category: "consumables", spentOn: "2026-09-02", amountMinor: 20_000, currency: "MDL" },
      // This month and another currency: neither is in the hint.
      { organizationId, name: "Гель", category: "materials", spentOn: "2026-10-01", amountMinor: 99_000, currency: "MDL" },
      { organizationId, name: "Gel", category: "materials", spentOn: "2026-08-01", amountMinor: 50_000, currency: "EUR" },
    ]);
  });

  it("spreads three months of purchases over the visits closed in them", async () => {
    await closeVisits(20, new Date("2026-08-10T06:00:00.000Z"));
    expect(await hint()).toBe(4_000);
  });

  it("is withheld below twenty visits", async () => {
    await closeVisits(19, new Date("2026-08-10T06:00:00.000Z"));
    expect(await hint()).toBeNull();
  });

  it("places a visit in the month the studio sees it in, not the UTC one", async () => {
    await closeVisits(19, new Date("2026-08-10T06:00:00.000Z"));
    // 22:30 UTC on 30 June is 01:30 on 1 July in Chișinău: one of the three months.
    await closeVisits(1, new Date("2026-06-30T22:30:00.000Z"));
    expect(await hint()).toBe(4_000);
  });
});
