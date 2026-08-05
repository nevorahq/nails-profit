import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { financialSnapshots, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadDashboard } from "@/lib/dashboard";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createOrganization, createService, createSpecialist, createUser } from "../helpers/factories";

/**
 * Gate 5: "dashboard загружается до 2 секунд на пилотном объёме", and spec
 * section 15.1 puts the same 2 s on a twelve-month period.
 *
 * Pilot volume is a studio of three masters working a full year: about two
 * thousand visits, one in ten of them corrected, so the newest-version rule has
 * something to choose between.
 *
 * The threshold is generous on purpose. This is not a benchmark, it is a guard
 * against the shape of query that used to be here — one round trip per visit,
 * which grows with the period and passes every test written against ten rows.
 */
const VISITS = 2_000;
const SPECIALISTS = 3;
const SERVICES = 10;
const BUDGET_MS = 2_000;

describe("dashboard performance at pilot volume", () => {
  let organizationId: string;

  beforeAll(async () => {
    await resetDatabase();

    const user = await createUser();
    const organization = await createOrganization({ ownerId: user.id });
    organizationId = organization.id;

    const specialistIds = await Promise.all(
      Array.from({ length: SPECIALISTS }, (_, index) =>
        createSpecialist(organizationId, { name: `Мастер ${index}` }).then((row) => row.id),
      ),
    );
    const serviceIds = await Promise.all(
      Array.from({ length: SERVICES }, (_, index) =>
        createService(organizationId, { name: `Услуга ${index}` }).then((row) => row.id),
      ),
    );

    const now = Date.now();
    const year = 365 * 24 * 60 * 60 * 1_000;

    const visitRows = Array.from({ length: VISITS }, (_, index) => ({
      organizationId,
      specialistId: specialistIds[index % SPECIALISTS],
      serviceId: serviceIds[index % SERVICES],
      completedAt: new Date(now - Math.floor((index / VISITS) * year)),
      plannedDurationMinutes: 90,
      actualDurationMinutes: 90,
      commissionType: "percentage" as const,
      commissionBasisPoints: 4_000,
    }));

    const inserted = await adminDb.insert(visits).values(visitRows).returning({ id: visits.id });

    await adminDb.insert(visitLines).values(
      inserted.map((visit, index) => ({
        organizationId,
        visitId: visit.id,
        kind: "service" as const,
        serviceId: serviceIds[index % SERVICES],
        nameSnapshot: { ru: `Услуга ${index % SERVICES}` },
        priceMinor: 60_000,
        durationMinutes: 90,
      })),
    );

    const snapshotRows = inserted.flatMap((visit, index) => {
      const base = {
        organizationId,
        visitId: visit.id,
        formulaVersion: "1.0.0",
        currency: "MDL" as const,
        revenueMinor: 60_000,
        materialCostMinor: 3_500,
        normativeMaterialCostMinor: 3_500,
        commissionMinor: 24_000,
        contributionMarginMinor: 32_500,
        marginBasisPoints: 5_417,
        profitPerHourMinor: 21_667,
        durationMinutes: 90,
      };

      // Every tenth visit was corrected, so the query has to pick a version.
      return index % 10 === 0
        ? [
            { ...base, snapshotVersion: 1, contributionMarginMinor: 30_000 },
            { ...base, snapshotVersion: 2 },
          ]
        : [{ ...base, snapshotVersion: 1 }];
    });

    for (let offset = 0; offset < snapshotRows.length; offset += 500) {
      await adminDb.insert(financialSnapshots).values(snapshotRows.slice(offset, offset + 500));
    }
  }, 120_000);

  afterAll(async () => {
    await closeTestConnections();
  });

  test("a twelve-month period is read within the budget", async () => {
    const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1_000);

    const started = performance.now();
    const { metrics } = await withTenant(organizationId, (tx) => loadDashboard(tx, { from }, "ru"));
    const elapsed = performance.now() - started;

    expect(metrics.visits).toBe(VISITS);
    // Only the newest version counts: 200 corrected visits at 325.00 plus 1 800
    // uncorrected at the same figure — the older 300.00 versions must not show.
    expect(metrics.contributionMarginMinor).toBe(VISITS * 32_500);

    console.log(`dashboard over ${VISITS} visits: ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  test("a one-month period is not paid for by the year around it", async () => {
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);

    const started = performance.now();
    const { metrics } = await withTenant(organizationId, (tx) => loadDashboard(tx, { from }, "ru"));
    const elapsed = performance.now() - started;

    expect(metrics.visits).toBeGreaterThan(0);
    expect(metrics.visits).toBeLessThan(VISITS);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
