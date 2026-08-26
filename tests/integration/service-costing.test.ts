import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadServiceCosting } from "@/lib/service-costing";
import { resetDatabase } from "../helpers/database";
import {
  createAddOn,
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * The assembly layer is where the catalogue, the commission rules and the
 * engine meet, so it is where a regression is most likely and least visible.
 * Unit tests cannot reach it: every one of these facts depends on real queries.
 */
describe("service costing over real data", () => {
  let organizationId: string;
  let specialistId: string;

  async function costing(serviceId: string, options: { specialistId?: string | null; at?: Date } = {}) {
    return withTenant(organizationId, async (tx) => {
      const [service] = await tx.select().from(services).where(eq(services.id, serviceId));
      return loadServiceCosting(tx, service, {
        specialistId: options.specialistId === undefined ? specialistId : options.specialistId,
        at: options.at,
      });
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });
  });

  it("reproduces the roadmap Gate 2 scenario from stored rows", async () => {
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });

    const result = await costing(service.id);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected a complete costing");
    expect(result.costing).toMatchObject({
      commissionMinor: 24_000,
      contributionMarginMinor: 36_000,
      marginBasisPoints: 6_000,
      profitPerHourMinor: 24_000,
    });
  });

  it("names every missing input at once", async () => {
    const service = await createService(organizationId, { priceMinor: null, durationMinutes: null });

    const result = await costing(service.id, { specialistId: null });

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect([...result.reasons].sort()).toEqual(
      ["missing_commission_rule", "missing_duration", "missing_price"].sort(),
    );
  });

  it("reports a missing commission rule rather than costing it as zero", async () => {
    const service = await createService(organizationId);

    const result = await costing(service.id, { specialistId: null });

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toEqual(["missing_commission_rule"]);
  });

  it("prefers a per-service commission exception over the default", async () => {
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    await createCommissionRule(organizationId, specialistId, {
      serviceId: service.id,
      basisPoints: 5_000,
    });

    const result = await costing(service.id);
    expect(result.status === "complete" && result.costing.commissionMinor).toBe(30_000);
  });

  it("does not rewrite history when a commission rule changes", async () => {
    // CST-009. Asking about a past date must still answer with the past rule.
    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });

    const specialist = await createSpecialist(organizationId, { name: "Историк" });
    const cutover = new Date("2026-06-01T00:00:00Z");
    await createCommissionRule(organizationId, specialist.id, {
      basisPoints: 3_000,
      activeFrom: new Date("2026-01-01T00:00:00Z"),
      activeTo: cutover,
    });
    await createCommissionRule(organizationId, specialist.id, {
      basisPoints: 4_000,
      activeFrom: cutover,
    });

    const past = await costing(service.id, {
      specialistId: specialist.id,
      at: new Date("2026-03-01T00:00:00Z"),
    });
    const now = await costing(service.id, {
      specialistId: specialist.id,
      at: new Date("2026-08-01T00:00:00Z"),
    });

    expect(past.status === "complete" && past.costing.commissionMinor).toBe(18_000);
    expect(now.status === "complete" && now.costing.commissionMinor).toBe(24_000);
  });

  it("reports a loss-making service as a loss", async () => {
    // A guaranteed 400 MDL to the master on a 300 MDL service: the studio pays
    // to do the work, and the figures have to say so rather than clamp to zero.
    const loser = await createSpecialist(organizationId, { name: "Дорогой" });
    await createCommissionRule(organizationId, loser.id, { type: "fixed", fixedAmountMinor: 40_000 });
    const service = await createService(organizationId, { priceMinor: 30_000, durationMinutes: 120 });

    const result = await costing(service.id, { specialistId: loser.id });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.contributionMarginMinor).toBeLessThan(0);
    expect(result.costing.marginBasisPoints).toBeLessThan(0);
    expect(result.costing.profitPerHourMinor).toBeLessThan(0);
  });

  it("never sees another organization's service", async () => {
    const other = await createOrganization({ name: "Other" });
    const otherService = await createService(other.id);

    // Reading the other tenant's service under our own context finds nothing at
    // all, so there is no costing to leak.
    const found = await withTenant(organizationId, (tx) =>
      tx.select().from(services).where(eq(services.id, otherService.id)),
    );
    expect(found).toEqual([]);
  });
});

/**
 * The roadmap lists "add-on с дополнительным временем" among the mandatory
 * phase 2 test cases. It is only meaningful against real rows: the price and
 * duration deltas come from the database.
 */
describe("costing a service together with its add-ons", () => {
  let organizationId: string;
  let specialistId: string;
  let serviceId: string;

  async function costing(addOnIds: string[]) {
    return withTenant(organizationId, async (tx) => {
      const [service] = await tx.select().from(services).where(eq(services.id, serviceId));
      return loadServiceCosting(tx, service, { specialistId, addOnIds });
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });

    const service = await createService(organizationId, { priceMinor: 60_000, durationMinutes: 90 });
    serviceId = service.id;
  });

  it("adds the price and the time of an add-on", async () => {
    const addOn = await createAddOn(organizationId, {
      priceDeltaMinor: 10_000,
      durationDeltaMinutes: 30,
    });

    const withAddOn = await costing([addOn.id]);

    expect(withAddOn.status).toBe("complete");
    if (withAddOn.status !== "complete") throw new Error("expected complete");
    // 700 MDL, 40% commission, 120 minutes.
    expect(withAddOn.costing).toMatchObject({
      priceMinor: 70_000,
      commissionMinor: 28_000,
      contributionMarginMinor: 42_000,
    });
    expect(withAddOn.costing.profitPerHourMinor).toBe(21_000);
  });

  it("applies a negative delta, since an add-on may shorten and discount", async () => {
    const addOn = await createAddOn(organizationId, {
      priceDeltaMinor: -10_000,
      durationDeltaMinutes: -30,
    });

    const result = await costing([addOn.id]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.priceMinor).toBe(50_000);
    // 60 minutes now, so the same margin is earned faster.
    expect(result.costing.profitPerHourMinor).toBe(30_000);
  });

  it("refuses to cost a set that drives the price below zero", async () => {
    const addOn = await createAddOn(organizationId, { priceDeltaMinor: -70_000 });

    const result = await costing([addOn.id]);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("negative_price_with_add_ons");
  });

  it("refuses to cost a set that leaves no duration", async () => {
    const addOn = await createAddOn(organizationId, { durationDeltaMinutes: -90 });

    const result = await costing([addOn.id]);

    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("expected incomplete");
    expect(result.reasons).toContain("invalid_duration_with_add_ons");
  });

  it("leaves the service unchanged when no add-on is selected", async () => {
    await createAddOn(organizationId, { priceDeltaMinor: 10_000 });

    const result = await costing([]);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.priceMinor).toBe(60_000);
  });

  it("ignores an add-on id belonging to another organization", async () => {
    const other = await createOrganization({ name: "Other" });
    const foreign = await createAddOn(other.id, { priceDeltaMinor: 999_000 });

    const result = await costing([foreign.id]);

    // RLS hides the row, so the delta cannot reach our costing.
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.costing.priceMinor).toBe(60_000);
  });
});
