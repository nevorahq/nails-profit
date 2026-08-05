import { and, count, eq, isNotNull, isNull } from "drizzle-orm";

import {
  commissionRules,
  financialSnapshots,
  materialPriceVersions,
  materials,
  recipes,
  services,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";

/**
 * Onboarding progress.
 *
 * Each step is the thing that has to be true before the next one can produce a
 * number, which is why the order is fixed and why a step is measured rather
 * than ticked off: a specialist without a commission rule, or a material
 * without a price, leaves the costing engine unable to answer — and the owner
 * staring at "не хватает данных" with no idea which piece is missing.
 *
 * The steps therefore check for the *usable* thing, not the row. A material
 * with no price version does not count as a material here.
 */
export type OnboardingStep = Readonly<{
  key: "specialist" | "materials" | "service" | "recipe" | "visit";
  done: boolean;
  href: string;
}>;

export type OnboardingProgress = Readonly<{
  steps: readonly OnboardingStep[];
  done: number;
  total: number;
  complete: boolean;
  /** The first unfinished step — what the interface should point at. */
  next: OnboardingStep | null;
}>;

export async function loadOnboarding(tx: TenantTransaction): Promise<OnboardingProgress> {
  const [withRule] = await tx
    .select({ value: count() })
    .from(specialists)
    .innerJoin(commissionRules, eq(commissionRules.specialistId, specialists.id))
    .where(isNull(specialists.archivedAt));

  const [pricedMaterials] = await tx
    .select({ value: count() })
    .from(materials)
    .innerJoin(materialPriceVersions, eq(materialPriceVersions.materialId, materials.id))
    .where(isNull(materials.archivedAt));

  const [usableServices] = await tx
    .select({ value: count() })
    .from(services)
    .where(
      and(
        isNull(services.archivedAt),
        isNotNull(services.priceMinor),
        isNotNull(services.durationMinutes),
      ),
    );

  const [anyRecipe] = await tx.select({ value: count() }).from(recipes);
  const [anySnapshot] = await tx.select({ value: count() }).from(financialSnapshots);

  const steps: OnboardingStep[] = [
    { key: "specialist", done: withRule.value > 0, href: "/app/specialists" },
    { key: "materials", done: pricedMaterials.value > 0, href: "/app/materials" },
    { key: "service", done: usableServices.value > 0, href: "/app/services" },
    { key: "recipe", done: anyRecipe.value > 0, href: "/app/services" },
    { key: "visit", done: anySnapshot.value > 0, href: "/app/visits/new" },
  ];

  const done = steps.filter((step) => step.done).length;

  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    next: steps.find((step) => !step.done) ?? null,
  };
}
