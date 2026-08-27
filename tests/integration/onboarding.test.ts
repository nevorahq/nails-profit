import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { commissionRules, expenses, scheduleRules, services, specialists } from "@/db/schema";
import type { Currency } from "@/domain/money";
import { withTenant } from "@/db/tenant";
import { loadMonthSetup, loadOnboarding, type MonthSetupStep, type OnboardingStep } from "@/lib/onboarding";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
  createLocation,
  createOrganization,
  createService,
  createSpecialist,
  createUser,
  createVisit,
} from "../helpers/factories";

/**
 * Onboarding measures state, and deletion in this application is archival — so
 * every one of these facts lives in the gap between the two. A unit test cannot
 * reach them: they are all about what the queries do or do not filter.
 */
describe("onboarding progress over real data", () => {
  let organizationId: string;
  let specialistId: string;

  async function progress() {
    return withTenant(organizationId, (tx) => loadOnboarding(tx));
  }

  async function step(key: OnboardingStep["key"]) {
    const { steps } = await progress();
    return steps.find((candidate) => candidate.key === key)!;
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
    await createCommissionRule(organizationId, specialistId, { basisPoints: 4_000 });
  });

  it("completes once a service and a closed visit exist", async () => {
    const service = await createService(organizationId);
    await createVisit(organizationId, { specialistId, serviceId: service.id });

    const result = await progress();

    expect(result.done).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.next).toBeNull();
  });

  it("un-ticks the specialist step when the commission rule has been ended", async () => {
    expect((await step("specialist")).done).toBe(true);

    await adminDb
      .update(commissionRules)
      .set({ activeTo: new Date(Date.now() - 1_000) })
      .where(eq(commissionRules.specialistId, specialistId));

    expect((await step("specialist")).done).toBe(false);
  });

  it("does not tick the specialist step on a rule that starts later", async () => {
    await adminDb.delete(commissionRules).where(eq(commissionRules.specialistId, specialistId));
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      activeFrom: new Date(Date.now() + 86_400_000),
    });

    expect((await step("specialist")).done).toBe(false);
  });

  it("un-ticks the specialist step when the only rule is an exception for a deleted service", async () => {
    const service = await createService(organizationId);
    await adminDb.delete(commissionRules).where(eq(commissionRules.specialistId, specialistId));
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      serviceId: service.id,
    });
    expect((await step("specialist")).done).toBe(true);

    await adminDb
      .update(services)
      .set({ archivedAt: new Date() })
      .where(eq(services.id, service.id));

    expect((await step("specialist")).done).toBe(false);
  });

  it("un-ticks the specialist step when every service the rule covers is deleted", async () => {
    const covered = await createService(organizationId, { name: "Покрытая" });
    const other = await createService(organizationId, { name: "Другая" });
    await adminDb.delete(commissionRules).where(eq(commissionRules.specialistId, specialistId));
    await createCommissionRule(organizationId, specialistId, {
      basisPoints: 4_000,
      coveredServiceIds: [covered.id],
    });
    expect((await step("specialist")).done).toBe(true);

    // The other service stays: a rule that covers only the deleted one pays for
    // nothing, however much catalogue is left around it.
    await adminDb
      .update(services)
      .set({ archivedAt: new Date() })
      .where(eq(services.id, covered.id));

    expect((await step("specialist")).done).toBe(false);
    expect(other.archivedAt).toBeNull();
  });

  it("keeps an unrestricted rule ticked before the catalogue exists", async () => {
    // No services at all, and the step is still complete — it comes before the
    // catalogue in the list and must not wait on it.
    expect((await step("specialist")).done).toBe(true);
    expect((await step("service")).done).toBe(false);
  });

  it("keeps the closed visit ticked after the catalogue is deleted", async () => {
    const service = await createService(organizationId);
    await createVisit(organizationId, { specialistId, serviceId: service.id });

    const archivedAt = new Date();
    await adminDb.update(services).set({ archivedAt }).where(eq(services.id, service.id));
    await adminDb
      .update(specialists)
      .set({ archivedAt })
      .where(eq(specialists.id, specialistId));

    const result = await progress();

    // The visit happened. Everything that describes present state is gone.
    expect(result.steps.filter((candidate) => candidate.done).map((candidate) => candidate.key)).toEqual([
      "visit",
    ]);
    expect(result.next?.key).toBe("specialist");
  });
});

/**
 * The month's checklist, which is about the ledger and the rota rather than the
 * catalogue — and about one month rather than about all time. Every fact below
 * lives in that second difference: a studio set up in January is not set up for
 * March, and a checklist that answered from the whole ledger would say it was.
 */
describe("month setup progress over real data", () => {
  const MONTH = "2026-03";
  let organizationId: string;
  let specialistId: string;

  async function step(key: MonthSetupStep["key"], month = MONTH) {
    const { steps } = await withTenant(organizationId, (tx) =>
      loadMonthSetup(tx, { month, currency: "MDL" }),
    );
    return steps.find((candidate) => candidate.key === key)!;
  }

  async function spend(
    options: {
      category?: "rent" | "payroll";
      spentOn?: string;
      currency?: Currency;
      isRecurring?: boolean;
      recurringFrom?: string;
      recurringTo?: string | null;
    } = {},
  ) {
    await adminDb.insert(expenses).values({
      organizationId,
      name: "Аренда",
      category: options.category ?? "rent",
      spentOn: options.spentOn ?? `${MONTH}-05`,
      amountMinor: 500_000,
      currency: options.currency ?? "MDL",
      isRecurring: options.isRecurring ?? false,
      recurringFrom: options.isRecurring ? (options.recurringFrom ?? options.spentOn ?? `${MONTH}-05`) : null,
      recurringTo: options.recurringTo ?? null,
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    organizationId = (await createOrganization({ ownerId: user.id })).id;
    specialistId = (await createSpecialist(organizationId)).id;
  });

  it("starts with neither step done", async () => {
    const progress = await withTenant(organizationId, (tx) =>
      loadMonthSetup(tx, { month: MONTH, currency: "MDL" }),
    );

    expect(progress.done).toBe(0);
    expect(progress.complete).toBe(false);
    expect(progress.next?.key).toBe("overhead");
  });

  it("ticks the overhead step on a cost the month carries", async () => {
    await spend();

    expect((await step("overhead")).done).toBe(true);
    // The same row, read for another month: one-off costs belong to the month
    // they were spent in and to no other.
    expect((await step("overhead", "2026-04")).done).toBe(false);
  });

  it("counts a recurring cost in every month it runs through", async () => {
    await spend({ spentOn: "2026-01-05", isRecurring: true, recurringFrom: "2026-01-05" });

    expect((await step("overhead", "2026-01")).done).toBe(true);
    expect((await step("overhead")).done).toBe(true);
    expect((await step("overhead", "2025-12")).done).toBe(false);
  });

  it("does not accept payroll as the month's fixed costs", async () => {
    // Wages leave the account, but the report already subtracts the master's
    // work through the visit's snapshot. A ledger of nothing but payroll leaves
    // the operating profit exactly where it was, so the step stays open.
    await spend({ category: "payroll" });

    expect((await step("overhead")).done).toBe(false);
  });

  it("does not accept a cost recorded in another currency", async () => {
    // The report counts one currency and says out loud how many rows it left
    // out; a step ticked by a row the P&L never adds would be a lie about the
    // same ledger.
    await spend({ currency: "EUR" });

    expect((await step("overhead")).done).toBe(false);
  });

  it("ticks the rota step once somebody has hours in the month", async () => {
    expect((await step("rota")).done).toBe(false);

    const location = await createLocation(organizationId);
    await adminDb.insert(scheduleRules).values({
      organizationId,
      specialistId,
      locationId: location.id,
      weekday: 1,
      startMinute: 9 * 60,
      endMinute: 18 * 60,
      effectiveFrom: "2026-03-01",
    });

    expect((await step("rota")).done).toBe(true);
    // The rota starts in March: February had no hours, and the step reads the
    // month it was asked about rather than the rule's existence.
    expect((await step("rota", "2026-02")).done).toBe(false);
  });
});
