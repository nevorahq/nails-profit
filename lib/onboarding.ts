import { and, count, eq, exists, gt, isNotNull, isNull, lte, max, notExists, or, sql } from "drizzle-orm";

import {
  commissionRuleServices,
  commissionRules,
  materialPriceVersions,
  materials,
  recipeItems,
  recipes,
  services,
  specialists,
  visits,
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
  const now = new Date();

  /*
   * A rule a visit could actually be paid by today, which takes three things.
   *
   * The window is the one `selectCommissionRule` applies — open at
   * `active_from`, closed at `active_to`. An ended rule is history: the
   * specialist costs as «нет правила комиссии» again, and the step has to say
   * so rather than remember that a rule was once written.
   *
   * The other two are the rule's restrictions, and both die with the catalogue
   * because deleting a service archives it rather than removing the row. A rule
   * with `service_id` is an exception for that one service; a rule with rows in
   * `commission_rule_service` pays only on those services, while no rows at all
   * means every service — that is what rules written before the table existed
   * do. Either way, once every service it names is archived, the rule pays for
   * nothing.
   *
   * What is deliberately *not* required is that the studio have any services at
   * all: an unrestricted rule is complete on its own, and this step comes before
   * the catalogue in the list.
   */
  const ruleTargetsLiveService = or(
    isNull(commissionRules.serviceId),
    exists(
      tx
        .select({ one: sql`1` })
        .from(services)
        .where(
          and(sql`${services.id} = ${commissionRules.serviceId}`, isNull(services.archivedAt)),
        ),
    ),
  );

  const ruleCoversLiveService = or(
    notExists(
      tx
        .select({ one: sql`1` })
        .from(commissionRuleServices)
        .where(eq(commissionRuleServices.commissionRuleId, commissionRules.id)),
    ),
    exists(
      tx
        .select({ one: sql`1` })
        .from(commissionRuleServices)
        .innerJoin(services, eq(services.id, commissionRuleServices.serviceId))
        .where(
          and(
            eq(commissionRuleServices.commissionRuleId, commissionRules.id),
            isNull(services.archivedAt),
          ),
        ),
    ),
  );

  const [withRule] = await tx
    .select({ value: count() })
    .from(specialists)
    .innerJoin(
      commissionRules,
      and(
        eq(commissionRules.specialistId, specialists.id),
        lte(commissionRules.activeFrom, now),
        or(isNull(commissionRules.activeTo), gt(commissionRules.activeTo, now)),
        ruleTargetsLiveService,
        ruleCoversLiveService,
      ),
    )
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

  /*
   * The recipe step asks whether a live service can be costed today — not
   * whether a recipe was ever written.
   *
   * Two things separate the two. Deleting a service archives it: `recipe`
   * cascades from `service`, but the cascade never fires, so an owner who
   * cleared the catalogue kept a ✓ against recipes nothing points at any more.
   * And clearing a recipe writes a new, empty version instead of removing the
   * old one (the PUT in app/api/v1/services/[id]/recipe keeps finished visits
   * costed the way they were costed), so only the newest version of each
   * service may be asked whether it still has materials in it.
   *
   * `service_id is not null` keeps an add-on's recipe out: it is a recipe, but
   * it is not the one this step names.
   */
  const latestRecipes = tx
    .select({
      serviceId: recipes.serviceId,
      // Aliased away from the column it aggregates: drizzle emits a subquery's
      // field unqualified, and `recipe_version` on both sides of the join is
      // ambiguous to PostgreSQL.
      recipeVersion: max(recipes.recipeVersion).as("latest_recipe_version"),
    })
    .from(recipes)
    .where(isNotNull(recipes.serviceId))
    .groupBy(recipes.serviceId)
    .as("latest_recipe");

  const [usableRecipes] = await tx
    .select({ value: count() })
    .from(recipes)
    .innerJoin(
      latestRecipes,
      and(
        eq(recipes.serviceId, latestRecipes.serviceId),
        eq(recipes.recipeVersion, latestRecipes.recipeVersion),
      ),
    )
    .innerJoin(services, eq(services.id, recipes.serviceId))
    .innerJoin(recipeItems, eq(recipeItems.recipeId, recipes.id))
    .where(isNull(services.archivedAt));

  /*
   * The one step that is a fact of history rather than a state of the data.
   *
   * A closed visit happened; archiving the service it was sold under does not
   * un-close it, and there is no way to delete one — `visit_status` is
   * `completed | adjusted`. So this ✓ is meant never to come back off, and it
   * counts the visits themselves rather than their snapshots, which are an
   * artefact of how the visit was costed.
   */
  const [closedVisits] = await tx.select({ value: count() }).from(visits);

  const steps: OnboardingStep[] = [
    { key: "specialist", done: withRule.value > 0, href: "/app/settings" },
    // The catalogue, with the add form already open — the step asks for one
    // material with a purchase price, and importing a file is the answer to a
    // different question. An owner who has a price list can still reach
    // /app/import from the navigation; an owner who has one bottle in front of
    // them was being sent to build a CSV.
    { key: "materials", done: pricedMaterials.value > 0, href: "/app/materials#add-material" },
    { key: "service", done: usableServices.value > 0, href: "/app/services" },
    { key: "recipe", done: usableRecipes.value > 0, href: "/app/services" },
    { key: "visit", done: closedVisits.value > 0, href: "/app/visits/new" },
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
