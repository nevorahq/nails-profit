import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { financialSnapshots } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadDashboard } from "@/lib/dashboard";
import { dataOf } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * The visit's life after it is closed: correction and the catalogue moving on.
 *
 * Both are promises the product makes about money that has already been
 * counted, which is why they are exercised end to end rather than in a unit
 * test. A correction must add a version instead of overwriting one, and last
 * month's profit must not change because a supplier raised a price today.
 */
describe("visit lifecycle", () => {
  let studio: Studio;
  let visitId: string;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("ledger@studio.example");

    visitId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: studio.specialistId,
        actual_duration_minutes: CANONICAL.serviceDurationMinutes,
        consumption: [],
      }),
    ).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("a correction writes a new version and leaves the first one standing", async () => {
    // Twice the material was actually used: 7 ml at 100 MDL per 10 ml is 70 MDL.
    await studio.owner.post(`/api/v1/visits/${visitId}/adjust`, {
      consumption: [{ material_id: studio.materialId, actual_quantity: 7 }],
      reason: "перерасход базы",
    });

    const snapshots = await withTenant(studio.organizationId, (tx) =>
      tx
        .select()
        .from(financialSnapshots)
        .where(eq(financialSnapshots.visitId, visitId))
        .orderBy(desc(financialSnapshots.snapshotVersion)),
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].snapshotVersion).toBe(2);
    expect(snapshots[0].materialUsageSource).toBe("actual");
    expect(snapshots[0].materialCostMinor).toBe(7_000);
    expect(snapshots[0].contributionMarginMinor).toBe(29_000);
    // Version 1 is untouched: this is an audit trail, not an edit history.
    expect(snapshots[1].snapshotVersion).toBe(1);
    expect(snapshots[1].materialUsageSource).toBe("standard");
    expect(snapshots[1].materialCostMinor).toBe(CANONICAL.materialCostMinor);
    expect(snapshots[1].contributionMarginMinor).toBe(CANONICAL.contributionMarginMinor);
  });

  test("the dashboard counts the correction once, not both versions", async () => {
    const { metrics } = await withTenant(studio.organizationId, (tx) => loadDashboard(tx, {}, "ru"));

    expect(metrics.visits).toBe(1);
    expect(metrics.contributionMarginMinor).toBe(29_000);
  });

  test("a later purchase price does not re-price a closed visit", async () => {
    await studio.owner.post(`/api/v1/materials/${studio.materialId}/prices`, {
      package_price_minor: CANONICAL.packagePriceMinor * 2,
      package_size: CANONICAL.packageSize,
    });

    const visits = dataOf<{ id: string; snapshot: { material_cost_minor: number } }[]>(
      await studio.owner.get("/api/v1/visits"),
    );
    expect(visits.find((visit) => visit.id === visitId)?.snapshot.material_cost_minor).toBe(7_000);

    // A visit closed after the change is priced at the new rate: the old figure
    // stood because it was snapshotted, not because prices are ignored.
    const freshId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: studio.specialistId,
        actual_duration_minutes: CANONICAL.serviceDurationMinutes,
        consumption: [],
      }),
    ).id;

    const afterPriceChange = dataOf<{ id: string; snapshot: { material_cost_minor: number } }[]>(
      await studio.owner.get("/api/v1/visits"),
    );
    expect(afterPriceChange.find((visit) => visit.id === freshId)?.snapshot.material_cost_minor).toBe(
      CANONICAL.materialCostMinor * 2,
    );
  });
});
