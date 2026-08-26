import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { financialSnapshots, visitLines } from "@/db/schema";
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
 * month's profit must not change because the studio re-prices a service today.
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
      }),
    ).id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("a correction writes a new version and leaves the first one standing", async () => {
    const [line] = await withTenant(studio.organizationId, (tx) =>
      tx.select({ id: visitLines.id }).from(visitLines).where(eq(visitLines.visitId, visitId)),
    );

    // 100 MDL given back: 500 taken in, 200 of commission on it.
    await studio.owner.post(`/api/v1/visits/${visitId}/adjust`, {
      refunds: [{ line_id: line.id, refund_minor: 10_000 }],
      reason: "вернули часть суммы",
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
    expect(snapshots[0].revenueMinor).toBe(50_000);
    expect(snapshots[0].commissionMinor).toBe(20_000);
    expect(snapshots[0].contributionMarginMinor).toBe(30_000);
    // Version 1 is untouched: this is an audit trail, not an edit history.
    expect(snapshots[1].snapshotVersion).toBe(1);
    expect(snapshots[1].revenueMinor).toBe(CANONICAL.servicePriceMinor);
    expect(snapshots[1].contributionMarginMinor).toBe(CANONICAL.contributionMarginMinor);
  });

  test("the dashboard counts the correction once, not both versions", async () => {
    const { metrics } = await withTenant(studio.organizationId, (tx) => loadDashboard(tx, {}, "ru"));

    expect(metrics.visits).toBe(1);
    expect(metrics.contributionMarginMinor).toBe(30_000);
  });

  test("a later price change does not re-price a closed visit", async () => {
    await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, {
      price_minor: CANONICAL.servicePriceMinor * 2,
    });

    const visits = dataOf<{ id: string; snapshot: { revenue_minor: number } }[]>(
      await studio.owner.get("/api/v1/visits"),
    );
    expect(visits.find((visit) => visit.id === visitId)?.snapshot.revenue_minor).toBe(50_000);

    // A visit closed after the change is charged at the new price: the old
    // figure stood because it was snapshotted, not because prices are ignored.
    const freshId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: studio.specialistId,
        actual_duration_minutes: CANONICAL.serviceDurationMinutes,
      }),
    ).id;

    const afterPriceChange = dataOf<{ id: string; snapshot: { revenue_minor: number } }[]>(
      await studio.owner.get("/api/v1/visits"),
    );
    expect(afterPriceChange.find((visit) => visit.id === freshId)?.snapshot.revenue_minor).toBe(
      CANONICAL.servicePriceMinor * 2,
    );
  });
});
