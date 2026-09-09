import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";

import { commissionRules, specialistAvatars, specialistServices, specialists } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { selectCommissionRule } from "@/domain/commission";

export type SpecialistRow = {
  id: string;
  name: string;
  cooperation_type: string;
  user_id: string | null;
  /** Takes the residual profit rather than a fee — the owner who also works. */
  is_principal: boolean;
  /** The version of their photo, or null when the card has none. */
  avatar_version: number | null;
  default_rule: {
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
    base: string;
  } | null;
  service_exceptions: {
    service_id: string | null;
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
    base: string;
  }[];
  service_assignments: {
    service_id: string;
    duration_minutes: number | null;
    requires_workplace: boolean;
  }[];
};

/**
 * A master's card, assembled the same way for the list and for the card's own
 * page.
 *
 * Both need the same six answers about a person — their rule, the exceptions
 * to it, what they are booked for, whether an account is behind them, whether
 * they are the working owner, and whether they have a photograph — and the
 * only difference between the two screens is how many people they ask about.
 * Written twice, the two would drift: the list would show a rule the card
 * disagreed with, and only one of them would be right.
 */
export async function loadSpecialistCards(
  tx: TenantTransaction,
  filter: Readonly<{
    id?: string;
    ownedBy?: string;
    /**
     * Strip what one named person is paid, for a role that reads aggregates —
     * `seesIndividualPay` in `domain/rbac.ts` decides who. The rate, the
     * per-service exceptions and the account behind the card come out; the
     * name, the cooperation type and the photograph stay, because an analyst
     * meets those in the calendar anyway.
     *
     * Redacted here rather than only hidden on screen, so the answer is the
     * same whether it is read by a page or by `GET /api/v1/specialists`. The
     * screens are told separately: a rule that was withheld and a rule that
     * was never written are the same `null`, and «не задана» would be a lie.
     */
    withoutPay?: boolean;
  }> = {},
): Promise<SpecialistRow[]> {
  const conditions: SQL[] = [isNull(specialists.archivedAt)];
  if (filter.id) conditions.push(eq(specialists.id, filter.id));
  // Section 6.1 limits a Master to their own card. The row carries the user it
  // belongs to, so the scope is enforced in the query rather than declared.
  if (filter.ownedBy) conditions.push(eq(specialists.userId, filter.ownedBy));

  const rows = await tx
    .select()
    .from(specialists)
    .where(and(...conditions))
    .orderBy(asc(specialists.createdAt));

  if (rows.length === 0) return [];
  const ids = rows.map((person) => person.id);

  const assignments = await tx
    .select({
      specialistId: specialistServices.specialistId,
      serviceId: specialistServices.serviceId,
      durationMinutes: specialistServices.durationOverrideMinutes,
      requiresWorkplace: specialistServices.requiresWorkplace,
    })
    .from(specialistServices)
    .where(inArray(specialistServices.specialistId, ids));

  const rules = await tx
    .select({
      specialistId: commissionRules.specialistId,
      id: commissionRules.id,
      serviceId: commissionRules.serviceId,
      type: commissionRules.type,
      basisPoints: commissionRules.basisPoints,
      fixedAmountMinor: commissionRules.fixedAmountMinor,
      base: commissionRules.base,
      activeFrom: commissionRules.activeFrom,
      activeTo: commissionRules.activeTo,
    })
    .from(commissionRules)
    .where(inArray(commissionRules.specialistId, ids));

  /*
   * The version of each photo, and never the photo. One row of metadata per
   * card, against a `select()` on the avatars themselves that would carry half
   * a megabyte per master into a page that draws each of them as a circle it
   * fetches separately anyway.
   */
  const avatars = await tx
    .select({ specialistId: specialistAvatars.specialistId, version: specialistAvatars.version })
    .from(specialistAvatars)
    .where(inArray(specialistAvatars.specialistId, ids));
  const avatarVersions = new Map(avatars.map((row) => [row.specialistId, row.version]));

  const now = new Date();

  return rows.map((person) => {
    const theirs = filter.withoutPay ? [] : rules.filter((rule) => rule.specialistId === person.id);
    const defaultRule = selectCommissionRule(
      theirs.filter((rule) => rule.serviceId === null),
      "",
    );
    const exceptions = theirs.filter(
      (rule) =>
        rule.serviceId !== null &&
        rule.activeFrom <= now &&
        (rule.activeTo === null || rule.activeTo > now),
    );

    return {
      id: person.id,
      name: person.name,
      cooperation_type: person.cooperationType,
      user_id: filter.withoutPay ? null : person.userId,
      is_principal: person.isPrincipal,
      avatar_version: avatarVersions.get(person.id) ?? null,
      default_rule: defaultRule
        ? {
            type: defaultRule.type,
            basis_points: defaultRule.basisPoints,
            fixed_amount_minor: defaultRule.fixedAmountMinor,
            base: defaultRule.base,
          }
        : null,
      service_exceptions: exceptions.map((rule) => ({
        service_id: rule.serviceId,
        type: rule.type,
        basis_points: rule.basisPoints,
        fixed_amount_minor: rule.fixedAmountMinor,
        base: rule.base,
      })),
      service_assignments: assignments
        .filter((assignment) => assignment.specialistId === person.id)
        .map((assignment) => ({
          service_id: assignment.serviceId,
          duration_minutes: assignment.durationMinutes,
          requires_workplace: assignment.requiresWorkplace,
        })),
    };
  });
}
