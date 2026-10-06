import { and, eq, gt, isNull, or } from "drizzle-orm";

import { chairRents, commissionRules } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import type { CommissionBase, CommissionType } from "@/domain/costing";
import { planZeroRule } from "@/domain/cooperation";
import { recordAuditEvent } from "@/lib/audit";

type Actor = Readonly<{ organizationId: string; userId: string; requestId: string }>;

export type DefaultRuleInput = Readonly<{
  type: CommissionType;
  basisPoints: number | null;
  fixedAmountMinor: number | null;
  base: CommissionBase;
}>;

const ZERO_RULE: DefaultRuleInput = {
  type: "percentage",
  basisPoints: 0,
  fixedAmountMinor: null,
  base: "after_discount",
};

/** The master's default rules still in force or still to come, locked. */
async function liveDefaultRules(tx: TenantTransaction, specialistId: string, now: Date) {
  return tx
    .select({
      id: commissionRules.id,
      type: commissionRules.type,
      basisPoints: commissionRules.basisPoints,
      fixedAmountMinor: commissionRules.fixedAmountMinor,
      activeFrom: commissionRules.activeFrom,
      activeTo: commissionRules.activeTo,
    })
    .from(commissionRules)
    .where(
      and(
        eq(commissionRules.specialistId, specialistId),
        isNull(commissionRules.serviceId),
        or(isNull(commissionRules.activeTo), gt(commissionRules.activeTo, now)),
      ),
    )
    .for("update");
}

async function closeRules(
  tx: TenantTransaction,
  actor: Actor,
  close: readonly Readonly<{ id: string; activeTo: Date }>[],
) {
  for (const rule of close) {
    await tx
      .update(commissionRules)
      .set({ activeTo: rule.activeTo, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(commissionRules.id, rule.id));
  }
}

async function openRule(
  tx: TenantTransaction,
  actor: Actor,
  specialistId: string,
  rule: DefaultRuleInput,
  now: Date,
  reason: string,
) {
  const [created] = await tx
    .insert(commissionRules)
    .values({
      organizationId: actor.organizationId,
      specialistId,
      serviceId: null,
      type: rule.type,
      basisPoints: rule.basisPoints,
      fixedAmountMinor: rule.fixedAmountMinor,
      base: rule.base,
      activeFrom: now,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning();

  await recordAuditEvent(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    eventType: "commission_rule.created",
    entityType: "commission_rule",
    entityId: created.id,
    after: {
      specialist_id: specialistId,
      service_id: null,
      type: created.type,
      basis_points: created.basisPoints,
      fixed_amount_minor: created.fixedAmountMinor,
      base: created.base,
      reason,
    },
    requestId: actor.requestId,
  });
  return created;
}

/**
 * A chair rented or a salary agreed: the visit owes the master nothing from
 * now on, and a rule says so — see `domain/cooperation.ts` for why it has to.
 * Visits already closed keep the rate they were snapshotted with.
 */
export async function zeroDefaultRule(
  tx: TenantTransaction,
  actor: Actor,
  specialistId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const plan = planZeroRule(await liveDefaultRules(tx, specialistId, now), now);
  await closeRules(tx, actor, plan.close);
  if (plan.open) await openRule(tx, actor, specialistId, ZERO_RULE, now, "cooperation");
  return plan.open;
}

/**
 * Back to a percentage, with the rate the owner has just given: every default
 * rule still in force or scheduled ends, and this one starts now.
 */
export async function replaceDefaultRule(
  tx: TenantTransaction,
  actor: Actor,
  specialistId: string,
  rule: DefaultRuleInput,
  now: Date = new Date(),
): Promise<void> {
  const live = await liveDefaultRules(tx, specialistId, now);
  await closeRules(
    tx,
    actor,
    live.map((row) => ({
      id: row.id,
      activeTo: row.activeFrom.getTime() > now.getTime() ? row.activeFrom : now,
    })),
  );
  await openRule(tx, actor, specialistId, rule, now, "cooperation");
}

/**
 * A renter who stops renting stops owing rent: the amount in force ends now,
 * and one scheduled for later ends at its own start. The month it ends in is
 * still owed whole, as a salary ended mid-month is — `domain/chair-rent.ts`.
 */
export async function endChairRent(
  tx: TenantTransaction,
  actor: Actor,
  specialistId: string,
  now: Date = new Date(),
): Promise<void> {
  const live = await tx
    .select({ id: chairRents.id, activeFrom: chairRents.activeFrom, amountMinor: chairRents.amountMinor })
    .from(chairRents)
    .where(
      and(
        eq(chairRents.specialistId, specialistId),
        or(isNull(chairRents.activeTo), gt(chairRents.activeTo, now)),
      ),
    )
    .for("update");

  for (const rent of live) {
    const activeTo = rent.activeFrom.getTime() > now.getTime() ? rent.activeFrom : now;
    await tx
      .update(chairRents)
      .set({ activeTo, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(chairRents.id, rent.id));
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "chair_rent.ended",
      entityType: "chair_rent",
      entityId: rent.id,
      before: { active_to: null },
      after: { active_to: activeTo, reason: "cooperation" },
      requestId: actor.requestId,
    });
  }
}
