import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { commissionRules, services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadOnboarding, type OnboardingStep } from "@/lib/onboarding";
import { adminDb, resetDatabase } from "../helpers/database";
import {
  createCommissionRule,
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
