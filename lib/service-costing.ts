import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { addOns, commissionRules, services } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { selectCommissionRule, toCommission } from "@/domain/commission";
import { calculateCosting, type CostingResult } from "@/domain/costing";
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

export async function loadServiceCosting(
  tx: TenantTransaction,
  service: typeof services.$inferSelect,
  options: { specialistId?: string | null; at?: Date; addOnIds?: readonly string[] } = {},
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
    const rules = await tx
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
      .where(
        and(
          eq(commissionRules.specialistId, options.specialistId),
          or(isNull(commissionRules.serviceId), eq(commissionRules.serviceId, service.id)),
        ),
      );
    commission = selectCommissionRule(rules, service.id, at);
  }
  if (!commission) reasons.push("missing_commission_rule");

  // The commission check is implied by `reasons`, but spelling it out is what
  // lets TypeScript narrow it below.
  if (reasons.length > 0 || !commission) {
    return { status: "incomplete", reasons };
  }

  const currency = (service.currency ?? "MDL") as Currency;
  const costing = calculateCosting({
    priceMinor: priceMinor!,
    durationMinutes: durationMinutes!,
    currency,
    commission: toCommission(commission),
  });

  return { status: "complete", currency, costing };
}
