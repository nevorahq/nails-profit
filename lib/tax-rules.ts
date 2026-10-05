import { and, eq, inArray, isNull } from "drizzle-orm";

import { organizations, taxRules } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { planRuleChange, type RuleChangeRefusal } from "@/domain/rule-change";
import { recordAuditEvent } from "@/lib/audit";

export type TaxKind = "vat" | "turnover" | "payroll";

export type TaxRuleInput = Readonly<{
  kind: TaxKind;
  basisPoints: number;
  remittable?: boolean;
  /** The studio's day the rate takes over from, `YYYY-MM-DD`; absent is now. */
  effectiveDate?: string;
}>;

type Created = typeof taxRules.$inferSelect;

/**
 * Write a tax rate, closing the one it replaces at the same instant.
 *
 * Two places write a rate — «Налоги с визита» and the month guide's «Как вы
 * платите налоги?» — and both have to leave the same row behind, so this is the
 * one way to do it.
 *
 * Two live rules of one kind would be a data error `selectTaxRates` has to
 * guess its way out of, and the guess it makes — take the newer — is a
 * fallback rather than a design. Closing here is the design. Locked, so that
 * two changes sent at once cannot both close the same rule.
 */
export async function createTaxRule(
  tx: TenantTransaction,
  actor: Readonly<{ organizationId: string; userId: string }>,
  input: TaxRuleInput,
  requestId: string,
): Promise<{ ok: true; row: Created } | { ok: false; reason: RuleChangeRefusal }> {
  const [organization] = await tx
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, actor.organizationId));
  const current = await tx
    .select({ id: taxRules.id, activeFrom: taxRules.activeFrom })
    .from(taxRules)
    .where(and(eq(taxRules.kind, input.kind), isNull(taxRules.activeTo)))
    .for("update");

  const plan = planRuleChange({
    current,
    effectiveDate: input.effectiveDate,
    now: new Date(),
    timezone: organization.timezone,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  if (plan.close.ids.length > 0) {
    await tx
      .update(taxRules)
      .set({ activeTo: plan.close.activeTo, updatedBy: actor.userId, updatedAt: new Date() })
      .where(inArray(taxRules.id, [...plan.close.ids]));
  }

  const [row] = await tx
    .insert(taxRules)
    .values({
      organizationId: actor.organizationId,
      kind: input.kind,
      basisPoints: input.basisPoints,
      remittable: input.remittable ?? true,
      activeFrom: plan.open.activeFrom,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning();

  await recordAuditEvent(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    eventType: "tax_rule.created",
    entityType: "tax_rule",
    entityId: row.id,
    after: {
      kind: row.kind,
      basis_points: row.basisPoints,
      remittable: row.remittable,
      active_from: row.activeFrom,
    },
    requestId,
  });

  return { ok: true, row };
}
