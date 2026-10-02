import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { financialSnapshots, visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";

import { dataOf, errorCodeOf } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { createAddOn, createCommissionRule, createSpecialist } from "../helpers/factories";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * A visit of several services, each paid under its own rule.
 *
 * Canonical studio: a 600 MDL manicure, 40% to the master. Added here: a 400 MDL
 * pedicure the studio pays a flat 150 for — an exception rule for that one
 * service — and a 100 MDL design. Every figure below is those two rules applied
 * to their own lines, never one rule to the whole visit.
 */
describe("a visit of several services", () => {
  let studio: Studio;
  let pedicureId: string;
  let designId: string;

  const PEDICURE_PRICE = 40_000;
  const PEDICURE_MINUTES = 60;
  const FLAT = 15_000;

  async function snapshotOf(visitId: string) {
    const [snapshot] = await withTenant(studio.organizationId, (tx) =>
      tx
        .select()
        .from(financialSnapshots)
        .where(eq(financialSnapshots.visitId, visitId))
        .orderBy(desc(financialSnapshots.snapshotVersion))
        .limit(1),
    );
    return snapshot;
  }

  async function linesOf(visitId: string) {
    return withTenant(studio.organizationId, (tx) =>
      tx.select().from(visitLines).where(eq(visitLines.visitId, visitId)),
    );
  }

  async function close(body: Record<string, unknown>) {
    return studio.owner.post("/api/v1/visits", {
      specialist_id: studio.specialistId,
      ...body,
    });
  }

  const both = () => [
    { service_id: studio.serviceId, add_on_ids: [] },
    { service_id: pedicureId, add_on_ids: [] },
  ];

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("several@studio.example", "Several Studio");
    pedicureId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/services", {
        name: { ru: "Педикюр" },
        price_minor: PEDICURE_PRICE,
        duration_minutes: PEDICURE_MINUTES,
      }),
    ).id;
    await createCommissionRule(studio.organizationId, studio.specialistId, {
      type: "fixed",
      fixedAmountMinor: FLAT,
      serviceId: pedicureId,
      activeFrom: new Date(Date.now() - 24 * 60 * 60_000),
    });
    designId = (await createAddOn(studio.organizationId, { name: "Дизайн", priceDeltaMinor: 10_000, durationDeltaMinutes: 15 }))
      .id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("pays each service under its own rule and adds up the time", async () => {
    const response = await close({ services: both() });
    expect(response.status).toBe(201);
    const visitId = dataOf<{ id: string }>(response).id;

    const snapshot = await snapshotOf(visitId);
    expect(snapshot.revenueMinor).toBe(CANONICAL.servicePriceMinor + PEDICURE_PRICE);
    // 40% of the manicure and a flat 150 for the pedicure — not 40% of 1 000.
    expect(snapshot.commissionMinor).toBe(CANONICAL.commissionMinor + FLAT);
    expect(snapshot.contributionMarginMinor).toBe(100_000 - 24_000 - FLAT);
    expect(snapshot.formulaVersion).toBe("costing-v4");

    const [visit] = await withTenant(studio.organizationId, (tx) =>
      tx.select().from(visits).where(eq(visits.id, visitId)),
    );
    expect(visit.plannedDurationMinutes).toBe(CANONICAL.serviceDurationMinutes + PEDICURE_MINUTES);
    // The first service stands for the visit, as the one service always did.
    expect(visit.serviceId).toBe(studio.serviceId);
    expect(visit.commissionType).toBe("percentage");

    const lines = await linesOf(visitId);
    const pedicure = lines.find((line) => line.serviceId === pedicureId)!;
    expect(pedicure).toMatchObject({ kind: "service", commissionType: "fixed", commissionFixedAmountMinor: FLAT });
    const manicure = lines.find((line) => line.serviceId === studio.serviceId)!;
    expect(manicure).toMatchObject({ commissionType: "percentage", commissionBasisPoints: 4_000 });
    expect(manicure.commissionRuleId).not.toBe(pedicure.commissionRuleId);
  });

  test("an add-on rides on the service it was chosen for", async () => {
    const onManicure = dataOf<{ id: string }>(
      await close({
        services: [
          { service_id: studio.serviceId, add_on_ids: [designId] },
          { service_id: pedicureId, add_on_ids: [] },
        ],
      }),
    ).id;
    // 40% of 600 + 100, and the flat 150.
    expect((await snapshotOf(onManicure)).commissionMinor).toBe(28_000 + FLAT);

    const onPedicure = dataOf<{ id: string }>(
      await close({
        services: [
          { service_id: studio.serviceId, add_on_ids: [] },
          { service_id: pedicureId, add_on_ids: [designId] },
        ],
      }),
    ).id;
    // The design is the pedicure's now, and a flat rule does not grow with it.
    expect((await snapshotOf(onPedicure)).commissionMinor).toBe(24_000 + FLAT);
    const design = (await linesOf(onPedicure)).find((line) => line.kind === "add_on")!;
    expect(design.serviceId).toBe(pedicureId);
    expect(design.commissionType).toBe("fixed");
  });

  test("a surcharge is split between the services by what each charges", async () => {
    const visitId = dataOf<{ id: string }>(await close({ services: both(), paid_minor: 110_000 })).id;

    const surcharges = (await linesOf(visitId)).filter((line) => line.kind === "surcharge");
    expect(
      surcharges.map((line) => [line.serviceId, line.priceMinor]).sort((a, b) => Number(b[1]) - Number(a[1])),
    ).toEqual([
      [studio.serviceId, 6_000],
      [pedicureId, 4_000],
    ]);
    const snapshot = await snapshotOf(visitId);
    expect(snapshot.revenueMinor).toBe(110_000);
    // 40% of 660, and the flat 150 on the pedicure's 440.
    expect(snapshot.commissionMinor).toBe(26_400 + FLAT);
  });

  test("paying less spreads the discount over every line, and the sum is what was paid", async () => {
    const visitId = dataOf<{ id: string }>(await close({ services: both(), paid_minor: 90_000 })).id;

    const lines = await linesOf(visitId);
    expect(lines.reduce((sum, line) => sum + line.priceMinor - line.discountMinor, 0)).toBe(90_000);
    expect(lines.find((line) => line.serviceId === studio.serviceId)!.discountMinor).toBe(6_000);
    // after_discount: 40% of 540, and the flat 150 untouched by the discount.
    expect((await snapshotOf(visitId)).commissionMinor).toBe(21_600 + FLAT);
  });

  test("still takes the single service_id every client already sends", async () => {
    const response = await close({ service_id: pedicureId, add_on_ids: [designId] });
    expect(response.status).toBe(201);
    const snapshot = await snapshotOf(dataOf<{ id: string }>(response).id);
    expect(snapshot.revenueMinor).toBe(PEDICURE_PRICE + 10_000);
    expect(snapshot.commissionMinor).toBe(FLAT);
  });

  test("refuses both forms at once, a service twice, and loose add-ons beside a list", async () => {
    const refusals = [
      { service_id: studio.serviceId, services: both() },
      {},
      { services: [] },
      { services: [...both(), { service_id: pedicureId, add_on_ids: [] }] },
      { services: both(), add_on_ids: [designId] },
    ];
    for (const body of refusals) {
      const response = await close(body);
      expect(response.status).toBe(422);
      expect(errorCodeOf(response)).toBe("VALIDATION_ERROR");
    }
  });

  test("refuses the visit when one of its services has no rule for this master", async () => {
    const newcomer = await createSpecialist(studio.organizationId, { name: "Новенькая" });
    // A rule for the manicure only: the pedicure would be worked for nothing.
    await createCommissionRule(studio.organizationId, newcomer.id, {
      basisPoints: 4_000,
      serviceId: studio.serviceId,
      activeFrom: new Date(Date.now() - 24 * 60 * 60_000),
    });

    const response = await studio.owner.post("/api/v1/visits", {
      specialist_id: newcomer.id,
      services: both(),
    });
    expect(response.status).toBe(422);
    expect(errorCodeOf(response)).toBe("MISSING_COMMISSION_RULE");

    const alone = await studio.owner.post("/api/v1/visits", {
      specialist_id: newcomer.id,
      services: [{ service_id: studio.serviceId, add_on_ids: [] }],
    });
    expect(alone.status).toBe(201);
  });

  test("refuses a service that is not in this studio's catalogue", async () => {
    const response = await close({
      services: [{ service_id: studio.serviceId, add_on_ids: [] }, { service_id: crypto.randomUUID(), add_on_ids: [] }],
    });
    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("SERVICE_NOT_FOUND");
  });
});
