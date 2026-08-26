import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { visitLines, visits } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadDashboard } from "@/lib/dashboard";
import { buildVisitDraft, recalculateVisitProfit, writeFinancialSnapshot } from "@/lib/visit-service";
import { resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * Gate 3: "Owner видит одинаковую прибыль в визите и dashboard" and "финансовые
 * агрегаты сходятся с суммой snapshots". Both are checked here against real
 * rows, because both are exactly the kind of thing that silently stops being
 * true when a query changes.
 */
/** Before every visit these tests create, so versioning never gets in the way. */
const EPOCH = new Date("2026-01-01T00:00:00Z");

describe("Studio Ledger", () => {
  let organizationId: string;
  let userId: string;
  let specialistId: string;
  let otherSpecialistId: string;

  async function closeVisit(options: {
    serviceId: string;
    specialistId?: string;
    completedAt?: Date;
  }) {
    return withTenant(organizationId, async (tx) => {
      const at = options.completedAt ?? new Date();
      const who = options.specialistId ?? specialistId;
      const draft = (await buildVisitDraft(tx, {
        serviceId: options.serviceId,
        addOnIds: [],
        specialistId: who,
        at,
      }))!;

      const [visit] = await tx
        .insert(visits)
        .values({
          organizationId,
          specialistId: who,
          serviceId: options.serviceId,
          completedAt: at,
          plannedDurationMinutes: draft.plannedDurationMinutes,
          actualDurationMinutes: draft.plannedDurationMinutes,
          commissionType: draft.commission!.type,
          commissionBasisPoints: draft.commission!.basisPoints,
          commissionFixedAmountMinor: draft.commission!.fixedAmountMinor,
        })
        .returning();

      await tx.insert(visitLines).values(
        draft.lines.map((line) => ({
          organizationId,
          visitId: visit.id,
          kind: line.kind,
          serviceId: line.serviceId,
          addOnId: line.addOnId,
          nameSnapshot: line.nameSnapshot,
          priceMinor: line.priceMinor,
          discountMinor: line.discountMinor,
          durationMinutes: line.durationMinutes,
        })),
      );

      const profit = (await recalculateVisitProfit(tx, visit.id))!.profit;
      const snapshot = await writeFinancialSnapshot(tx, {
        organizationId,
        visitId: visit.id,
        profit,
        actorUserId: userId,
      });
      return { visitId: visit.id, snapshot };
    });
  }

  async function dashboard(filters: Parameters<typeof loadDashboard>[1] = {}) {
    return withTenant(organizationId, (tx) => loadDashboard(tx, filters, "ru"));
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    userId = user.id;
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId, { name: "Ирина" })).id;
    otherSpecialistId = (await createSpecialist(organizationId, { name: "Ольга" })).id;
    // Effective well before any visit in these tests. Dating the rule "a minute
    // ago" would make a visit backdated to June find no rule at all — correct
    // behaviour, but not what these tests are measuring.
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000, activeFrom: EPOCH });
    await createCommissionRule(organizationId, otherSpecialistId, {
      basisPoints: 4_000,
      activeFrom: EPOCH,
    });

  });

  async function service(name: string, priceMinor: number, durationMinutes: number) {
    return createService(organizationId, { name, priceMinor, durationMinutes });
  }

  it("totals exactly what the visits report individually", async () => {
    const svc = await service("Маникюр", 60_000, 90);
    const first = await closeVisit({ serviceId: svc.id });
    const second = await closeVisit({ serviceId: svc.id });

    const { metrics } = await dashboard();

    // Gate 3: the dashboard is the sum of the visits, to the minor unit.
    expect(metrics.contributionMarginMinor).toBe(
      first.snapshot.contributionMarginMinor! + second.snapshot.contributionMarginMinor!,
    );
    expect(metrics.revenueMinor).toBe(first.snapshot.revenueMinor + second.snapshot.revenueMinor);
  });

  it("counts a corrected visit once, at its newest version", async () => {
    // Summing every snapshot version would double-count every correction. This
    // is the failure Gate 3's "агрегаты сходятся с суммой snapshots" catches.
    const manicure = await service("Маникюр", 60_000, 90);
    const { visitId } = await closeVisit({ serviceId: manicure.id });

    const corrected = await withTenant(organizationId, async (tx) => {
      await tx.update(visitLines).set({ refundMinor: 10_000 }).where(eq(visitLines.visitId, visitId));
      const profit = (await recalculateVisitProfit(tx, visitId))!.profit;
      return writeFinancialSnapshot(tx, {
        organizationId,
        visitId,
        profit,
        actorUserId: userId,
      });
    });

    const { metrics } = await dashboard();

    expect(metrics.visits).toBe(1);
    expect(corrected.snapshotVersion).toBe(2);
    // 360 was version 1; only the 300 of version 2 counts.
    expect(metrics.contributionMarginMinor).toBe(corrected.contributionMarginMinor);
    expect(metrics.contributionMarginMinor).toBe(30_000);
  });

  it("does not restate a period when the service price changes afterwards", async () => {
    const manicure = await service("Маникюр", 60_000, 90);
    await closeVisit({ serviceId: manicure.id });
    const before = await dashboard();

    const { services } = await import("@/db/schema");
    const { adminDb } = await import("../helpers/database");
    await adminDb.update(services).set({ priceMinor: 90_000 }).where(eq(services.id, manicure.id));

    const after = await dashboard();
    expect(after.metrics.contributionMarginMinor).toBe(before.metrics.contributionMarginMinor);
  });

  it("costs every closed visit and leaves none incomplete", async () => {
    const manicure = await service("Маникюр", 60_000, 90);
    await closeVisit({ serviceId: manicure.id });
    await closeVisit({ serviceId: manicure.id });

    const { metrics } = await dashboard();

    expect(metrics.visits).toBe(2);
    expect(metrics.revenueMinor).toBe(120_000);
    expect(metrics.costedVisits).toBe(2);
    expect(metrics.incompleteVisits).toBe(0);
    expect(metrics.incompleteRevenueMinor).toBe(0);
    expect(metrics.marginBasisPoints).toBe(6_000);
    expect(metrics.incompleteReasonCounts).toEqual({});
  });

  it("filters by period", async () => {
    const svc = await service("Маникюр", 60_000, 90);
    await closeVisit({
      serviceId: svc.id,
      completedAt: new Date("2026-06-15T10:00:00Z"),
    });
    await closeVisit({
      serviceId: svc.id,
      completedAt: new Date("2026-08-15T10:00:00Z"),
    });

    const june = await dashboard({
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-30T23:59:59Z"),
    });

    expect(june.metrics.visits).toBe(1);
    expect(june.metrics.revenueMinor).toBe(60_000);
  });

  it("filters by specialist", async () => {
    const svc = await service("Маникюр", 60_000, 90);
    await closeVisit({ serviceId: svc.id });
    await closeVisit({ serviceId: svc.id, specialistId: otherSpecialistId });

    const mine = await dashboard({ specialistId });
    expect(mine.metrics.visits).toBe(1);

    const everyone = await dashboard();
    expect(everyone.metrics.visits).toBe(2);
  });

  it("ranks by margin while showing that per hour the order differs", async () => {
    const long = await service("Наращивание", 100_000, 180);
    const quick = await service("Экспресс", 30_000, 30);
    await closeVisit({ serviceId: long.id });
    await closeVisit({ serviceId: quick.id });

    const { metrics } = await dashboard();

    expect(metrics.ranking.map((entry) => entry.serviceName)).toEqual(["Наращивание", "Экспресс"]);
    // The quick service earns less per visit but more per hour — the decision
    // the ranking exists to surface.
    expect(metrics.ranking[1].profitPerHourMinor).toBeGreaterThan(
      metrics.ranking[0].profitPerHourMinor!,
    );
  });

  it("names an archived service by what the visit recorded", async () => {
    const svc = await service("Старое название", 60_000, 90);
    await closeVisit({ serviceId: svc.id });

    const { services } = await import("@/db/schema");
    const { adminDb } = await import("../helpers/database");
    await adminDb
      .update(services)
      .set({ archivedAt: new Date(), name: { ru: "Переименована" } })
      .where(eq(services.id, svc.id));

    const { metrics } = await dashboard();
    expect(metrics.ranking[0].serviceName).toBe("Старое название");
  });

  it("shows nothing rather than zeroes for an organization with no visits", async () => {
    const { metrics } = await dashboard();

    expect(metrics.visits).toBe(0);
    expect(metrics.marginBasisPoints).toBeNull();
    expect(metrics.ranking).toEqual([]);
  });

  it("never counts another organization's visits", async () => {
    const other = await createOrganization({ name: "Other" });
    const otherSpecialist = await createSpecialist(other.id);
    await createCommissionRule(other.id, otherSpecialist.id, { basisPoints: 4_000 });
    await createService(other.id, { priceMinor: 999_000, durationMinutes: 90 });

    const svc = await service("Маникюр", 60_000, 90);
    await closeVisit({ serviceId: svc.id });

    const { metrics } = await dashboard();
    expect(metrics.visits).toBe(1);
    expect(metrics.revenueMinor).toBe(60_000);
  });
});
