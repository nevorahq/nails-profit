import { asc, count, desc, eq, isNull } from "drizzle-orm";

import { locations, organizations, organizationSubscriptions, pilotEnrollments, specialists } from "@/db/schema";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import {
  locationCap,
  lowestTierFor,
  planAllows,
  resolvePlan,
  specialistCap,
  type PlanFeature,
  type PlanTier,
  type ResolvedPlan,
} from "@/domain/plans";
import { isPlanLimitsEnforced } from "@/env";
import { apiError } from "@/lib/http";
import { planForPaddlePrice } from "@/lib/paddle-catalog";

/**
 * The studio's tariff as the database has it, resolved by `resolvePlan`.
 * Called inside the tenant transaction the request already holds, so RLS
 * scopes every read to the one organization.
 */
export async function loadOrganizationPlan(
  tx: TenantTransaction,
  organizationId: string,
  now: Date = new Date(),
): Promise<ResolvedPlan> {
  const [organization] = await tx
    .select({ createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const [subscription] = await tx
    .select({
      provider: organizationSubscriptions.provider,
      status: organizationSubscriptions.status,
      priceId: organizationSubscriptions.providerPriceId,
    })
    .from(organizationSubscriptions)
    .limit(1);
  const [pilot] = await tx.select({ status: pilotEnrollments.status }).from(pilotEnrollments).limit(1);

  const environment = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT?.trim() === "sandbox" ? "sandbox" : "live";
  return resolvePlan({
    subscription: subscription
      ? {
          status: subscription.status,
          tier:
            subscription.provider === "paddle"
              ? (planForPaddlePrice(environment, subscription.priceId)?.tier ?? null)
              : null,
        }
      : null,
    pilotActive: pilot?.status === "active",
    // A row RLS hides is not a studio this request may act for; the caller
    // would not have got this far. Now keeps the resolver total regardless.
    organizationCreatedAt: organization?.createdAt ?? now,
    now,
  });
}

/**
 * The tier the limits are applied at: the studio's own while
 * `PLAN_LIMITS_ENFORCEMENT` is on, «Бизнес» — nothing held back — while it is
 * off. Every check below goes through this, so the flag is read in one place.
 */
export async function enforcedTier(tx: TenantTransaction, organizationId: string): Promise<PlanTier> {
  if (!isPlanLimitsEnforced()) return "business";
  return (await loadOrganizationPlan(tx, organizationId)).tier;
}

export async function planAllowsFeature(
  tx: TenantTransaction,
  organizationId: string,
  feature: PlanFeature,
): Promise<boolean> {
  return planAllows(await enforcedTier(tx, organizationId), feature);
}

/**
 * The refusal for a feature the studio's tier does not open. 402 rather than
 * 403: the role may do this, the tariff may not, and the answer is to pay
 * rather than to ask the owner. `details.tier` is the cheapest tier that
 * would allow it, for a screen that wants to name it.
 */
export function planRefusal(id: string, feature: PlanFeature) {
  return apiError(402, "PLAN_UPGRADE_REQUIRED", `This needs the ${lowestTierFor(feature)} plan or above`, id, {
    details: { feature, tier: lowestTierFor(feature) },
  });
}

/**
 * Whether one more active specialist fits the tier. Archived people do not
 * count: archiving is how a studio makes room.
 */
export async function hasRoomForSpecialist(tx: TenantTransaction, organizationId: string): Promise<boolean> {
  const cap = specialistCap(await enforcedTier(tx, organizationId));
  if (cap === null) return true;
  const [row] = await tx.select({ value: count() }).from(specialists).where(isNull(specialists.archivedAt));
  return (row?.value ?? 0) < cap;
}

/** Whether one more active location fits the tier. */
export async function hasRoomForLocation(tx: TenantTransaction, organizationId: string): Promise<boolean> {
  const cap = locationCap(await enforcedTier(tx, organizationId));
  if (cap === null) return true;
  const [row] = await tx.select({ value: count() }).from(locations).where(eq(locations.status, "active"));
  return (row?.value ?? 0) < cap;
}

/**
 * The specialists a capped tier still works with, or `null` when nothing is
 * capped.
 *
 * A studio that hired three people during its trial and then stayed on
 * «Старт» keeps all three cards — nothing is deleted — but only the first
 * takes new appointments: the studio's own master card first, then the
 * longest-standing. Without this the trial would be a way to keep a team
 * free for ever.
 */
export async function workingSpecialistIds(
  tx: TenantTransaction,
  organizationId: string,
): Promise<ReadonlySet<string> | null> {
  const cap = specialistCap(await enforcedTier(tx, organizationId));
  if (cap === null) return null;
  const rows = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(isNull(specialists.archivedAt))
    .orderBy(desc(specialists.isPrincipal), asc(specialists.createdAt), asc(specialists.id))
    .limit(cap);
  return new Set(rows.map((row) => row.id));
}

export function planSpecialistRefusal(id: string) {
  return apiError(402, "PLAN_SPECIALIST_LIMIT", "This plan works with one specialist", id, {
    details: { tier: "studio" },
  });
}

export function planLocationRefusal(id: string) {
  return apiError(402, "PLAN_LOCATION_LIMIT", "A second location needs the business plan", id, {
    details: { tier: "business" },
  });
}

/*
 * The route-level forms of the checks above: `null` to go on, or the response
 * to return. Each skips the database entirely while the limits are off, so a
 * route pays for the check only where it can refuse.
 */

/** For a page: whether the studio's tier opens a feature, in a transaction of its own. */
export async function organizationAllows(organizationId: string, feature: PlanFeature): Promise<boolean> {
  if (!isPlanLimitsEnforced()) return true;
  return withTenant(organizationId, (tx) => planAllowsFeature(tx, organizationId, feature));
}

/** For a page: whether one more master or address fits the studio's tier. */
export async function organizationHasRoom(organizationId: string, what: "specialist" | "location"): Promise<boolean> {
  if (!isPlanLimitsEnforced()) return true;
  return withTenant(organizationId, (tx) =>
    what === "specialist" ? hasRoomForSpecialist(tx, organizationId) : hasRoomForLocation(tx, organizationId),
  );
}

export async function planFeatureRefusal(organizationId: string, feature: PlanFeature, id: string) {
  return (await organizationAllows(organizationId, feature)) ? null : planRefusal(id, feature);
}

export async function specialistRoomRefusal(organizationId: string, id: string) {
  if (!isPlanLimitsEnforced()) return null;
  const room = await withTenant(organizationId, (tx) => hasRoomForSpecialist(tx, organizationId));
  return room ? null : planSpecialistRefusal(id);
}

export async function locationRoomRefusal(organizationId: string, id: string) {
  if (!isPlanLimitsEnforced()) return null;
  const room = await withTenant(organizationId, (tx) => hasRoomForLocation(tx, organizationId));
  return room ? null : planLocationRefusal(id);
}

/** Refuses new appointments for a specialist past the tier's cap — see `workingSpecialistIds`. */
export async function workingSpecialistRefusal(organizationId: string, specialistId: string, id: string) {
  if (!isPlanLimitsEnforced()) return null;
  const working = await withTenant(organizationId, (tx) => workingSpecialistIds(tx, organizationId));
  return working === null || working.has(specialistId) ? null : planSpecialistRefusal(id);
}
