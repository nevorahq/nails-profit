import { eq, inArray } from "drizzle-orm";

import { addOns, commissionRules, services } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { selectCommissionRule, toCommission } from "@/domain/commission";
import { calculateCosting, type CostingResult } from "@/domain/costing";
import type { MaterialsCostingMode } from "@/domain/materials-mode";
import type { Currency } from "@/domain/money";

/**
 * Assembles a service costing out of stored data.
 *
 * `calculateCosting` stays strict — a missing price or a zero duration is a
 * programming error there and throws. Gaps in *data* are a different thing:
 * SRV-007 wants an unpriced service flagged, not rejected, so this layer checks
 * the preconditions first and reports what is missing. The engine is only called
 * once every input it needs actually exists.
 */
export type ServiceCostingReason =
  | "missing_price"
  | "missing_duration"
  | "missing_commission_rule"
  // SRV-003 lets an add-on shift price and duration in either direction, so a
  // badly configured set can push either below zero. That is a configuration
  // error, not a number to hand back.
  | "negative_price_with_add_ons"
  | "invalid_duration_with_add_ons";

export type ServiceCosting = Readonly<
  | {
      status: "complete";
      currency: Currency;
      costing: CostingResult;
    }
  | {
      status: "incomplete";
      reasons: readonly ServiceCostingReason[];
    }
>;

export type CommissionRuleRow = Awaited<ReturnType<typeof loadCommissionRulesOf>>[number];

/** Every commission rule a specialist has, for any service or for all of them. */
export async function loadCommissionRulesOf(tx: TenantTransaction, specialistId: string) {
  return tx
    .select({
      id: commissionRules.id,
      serviceId: commissionRules.serviceId,
      type: commissionRules.type,
      basisPoints: commissionRules.basisPoints,
      fixedAmountMinor: commissionRules.fixedAmountMinor,
      activeFrom: commissionRules.activeFrom,
      activeTo: commissionRules.activeTo,
    })
    .from(commissionRules)
    .where(eq(commissionRules.specialistId, specialistId));
}

/**
 * The costing of each service in a list, in a fixed number of statements.
 *
 * Costing one service reads the specialist's commission rules, and a list used
 * to do that once per service — four services, four identical reads, each a
 * round trip to a database in another region. The rules are the same for all of
 * them, so they are read once and handed to each.
 */
export async function loadServiceCostings(
  tx: TenantTransaction,
  catalogue: readonly (typeof services.$inferSelect)[],
  options: Omit<Parameters<typeof loadServiceCosting>[2] & object, "rules" | "addOnIds"> = {},
): Promise<ServiceCosting[]> {
  const rules = options.specialistId ? await loadCommissionRulesOf(tx, options.specialistId) : [];
  return Promise.all(catalogue.map((service) => loadServiceCosting(tx, service, { ...options, rules })));
}

export async function loadServiceCosting(
  tx: TenantTransaction,
  service: typeof services.$inferSelect,
  options: {
    specialistId?: string | null;
    at?: Date;
    addOnIds?: readonly string[];
    /**
     * How the studio counts materials this month (`lib/materials-mode.ts`).
     * Absent is `purchases`: the amounts on services are not this costing's
     * business, and a caller that has not asked costs exactly as before.
     */
    materialsMode?: MaterialsCostingMode;
    /**
     * The specialist's commission rules, when the caller already holds them —
     * what `loadCommissionRulesOf` returns. Without them each call asks the
     * database, and a list of services asks once per service.
     */
    rules?: readonly CommissionRuleRow[];
  } = {},
): Promise<ServiceCosting> {
  const at = options.at ?? new Date();
  const reasons: ServiceCostingReason[] = [];

  // SRV-003: an add-on shifts price and duration. RLS keeps the lookup
  // tenant-scoped, so an id from another organization simply finds nothing.
  const selectedAddOns =
    options.addOnIds && options.addOnIds.length > 0
      ? await tx.select().from(addOns).where(inArray(addOns.id, [...options.addOnIds]))
      : [];

  const priceDelta = selectedAddOns.reduce((total, addOn) => total + addOn.priceDeltaMinor, 0);
  const durationDelta = selectedAddOns.reduce((total, addOn) => total + addOn.durationDeltaMinutes, 0);
  const priceMinor = service.priceMinor === null ? null : service.priceMinor + priceDelta;
  const durationMinutes =
    service.durationMinutes === null ? null : service.durationMinutes + durationDelta;

  if (service.priceMinor === null) reasons.push("missing_price");
  else if (priceMinor! < 0) reasons.push("negative_price_with_add_ons");
  if (service.durationMinutes === null) reasons.push("missing_duration");
  else if (durationMinutes! <= 0) reasons.push("invalid_duration_with_add_ons");

  let commission = null;
  if (options.specialistId) {
    // Every rule the specialist has, kept to the ones that can apply to this
    // service. A caller costing a list loads them once and hands them in.
    const rules = (options.rules ?? (await loadCommissionRulesOf(tx, options.specialistId))).filter(
      (rule) => rule.serviceId === null || rule.serviceId === service.id,
    );
    commission = selectCommissionRule(rules, service.id, at);
  }
  if (!commission) reasons.push("missing_commission_rule");

  // The commission check is implied by `reasons`, but spelling it out is what
  // lets TypeScript narrow it below.
  if (reasons.length > 0 || !commission) {
    return { status: "incomplete", reasons };
  }

  // Null on either is «not given», which costs as nothing rather than as a gap.
  const materialsMinor =
    options.materialsMode === "per_service"
      ? (service.materialsMinor ?? 0) +
        selectedAddOns.reduce((total, addOn) => total + (addOn.materialsMinor ?? 0), 0)
      : 0;

  const currency = (service.currency ?? "MDL") as Currency;
  const costing = calculateCosting({
    materialsMinor,
    priceMinor: priceMinor!,
    durationMinutes: durationMinutes!,
    currency,
    commission: toCommission(commission),
  });

  return { status: "complete", currency, costing };
}
