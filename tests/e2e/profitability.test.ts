import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { withTenant } from "@/db/tenant";
import { loadDashboard } from "@/lib/dashboard";
import { dataOf } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * Spec section 17.1, end-to-end scenario A.
 *
 * A service at 600 MDL, a 40% commission and a 35 MDL recipe must produce the
 * same six figures in the service card, in the visit and on the dashboard. The
 * roadmap's Gate 2 uses the same numbers, and this is the test that proves the
 * product — not the formula module — arrives at them: every step of the setup
 * is an HTTP request an owner's browser would make, from sign-up onward.
 */
describe("scenario A: profitability", () => {
  let studio: Studio;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("owner@studio.example");
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("the service card shows the canonical figures", async () => {
    const service = dataOf<{ costing: Record<string, unknown> }>(
      await studio.owner.get(`/api/v1/services/${studio.serviceId}`),
    );

    expect(service.costing).toMatchObject({
      status: "complete",
      material_cost_minor: CANONICAL.materialCostMinor,
      commission_minor: CANONICAL.commissionMinor,
      contribution_margin_minor: CANONICAL.contributionMarginMinor,
      margin_basis_points: CANONICAL.marginBasisPoints,
      profit_per_hour_minor: CANONICAL.profitPerHourMinor,
    });
  });

  test("the closed visit carries the same figures", async () => {
    const created = dataOf<{ id: string; snapshot: Record<string, unknown> }>(
      await studio.owner.post("/api/v1/visits", {
        service_id: studio.serviceId,
        specialist_id: studio.specialistId,
        actual_duration_minutes: CANONICAL.serviceDurationMinutes,
        consumption: [{ material_id: studio.materialId, actual_quantity: CANONICAL.recipeQuantity }],
      }),
    );

    expect(created.snapshot).toMatchObject({
      version: 1,
      revenue_minor: CANONICAL.servicePriceMinor,
      contribution_margin_minor: CANONICAL.contributionMarginMinor,
      profit_per_hour_minor: CANONICAL.profitPerHourMinor,
      incomplete_reasons: [],
    });

    const visits = dataOf<{ id: string; snapshot: Record<string, unknown> }[]>(
      await studio.owner.get("/api/v1/visits"),
    );

    expect(visits.find((visit) => visit.id === created.id)?.snapshot).toMatchObject({
      material_cost_minor: CANONICAL.materialCostMinor,
      commission_minor: CANONICAL.commissionMinor,
      contribution_margin_minor: CANONICAL.contributionMarginMinor,
      margin_basis_points: CANONICAL.marginBasisPoints,
      profit_per_hour_minor: CANONICAL.profitPerHourMinor,
    });
  });

  test("the dashboard reports the same figures", async () => {
    // The dashboard is a server component, so this enters one step below the
    // page — at the loader the page calls, inside the same tenant transaction.
    const { metrics } = await withTenant(studio.organizationId, (tx) => loadDashboard(tx, {}, "ru"));

    expect(metrics).toMatchObject({
      visits: 1,
      costedVisits: 1,
      revenueMinor: CANONICAL.servicePriceMinor,
      costedRevenueMinor: CANONICAL.servicePriceMinor,
      actualMaterialCostMinor: CANONICAL.materialCostMinor,
      contributionMarginMinor: CANONICAL.contributionMarginMinor,
      marginBasisPoints: CANONICAL.marginBasisPoints,
      profitPerHourMinor: CANONICAL.profitPerHourMinor,
      incompleteVisits: 0,
    });
  });
});
