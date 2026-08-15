import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { ToolIcon } from "@/components/icons";
import { db } from "@/db";
import { commissionRules, memberships, services, specialistServices, specialists, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { selectCommissionRule } from "@/domain/commission";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { SpecialistManager, type SpecialistRow } from "@/components/specialist-manager";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function SpecialistsPage() {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "commissions", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("specialists.noAccess")}</p>
      </main>
    );
  }

  // Section 6.1 limits a Master to t("specialists.ownOnly"). The specialist
  // row carries the user it belongs to, so the scope is enforced here rather
  // than merely declared.
  const ownOnly = scopeFor(membership.role, "commissions") === "own";

  const { people, catalogue } = await withTenant(membership.organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(specialists)
      .where(
        ownOnly
          ? and(isNull(specialists.archivedAt), eq(specialists.userId, membership.userId))
          : isNull(specialists.archivedAt),
      )
      .orderBy(asc(specialists.createdAt));

    const serviceRows = await tx
      .select()
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    const assignments = rows.length
      ? await tx
          .select({
            specialistId: specialistServices.specialistId,
            serviceId: specialistServices.serviceId,
            durationMinutes: specialistServices.durationOverrideMinutes,
            requiresWorkplace: specialistServices.requiresWorkplace,
          })
          .from(specialistServices)
          .where(inArray(specialistServices.specialistId, rows.map((person) => person.id)))
      : [];

    const people: SpecialistRow[] = await Promise.all(
      rows.map(async (person) => {
        const rules = await tx
          .select({
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
          .where(eq(commissionRules.specialistId, person.id));

        const defaults = rules.filter((rule) => rule.serviceId === null);
        const defaultRule = selectCommissionRule(defaults, "");

        const now = new Date();
        const exceptions = rules.filter(
          (rule) =>
            rule.serviceId !== null &&
            rule.activeFrom <= now &&
            (rule.activeTo === null || rule.activeTo > now),
        );

        return {
          id: person.id,
          name: person.name,
          cooperation_type: person.cooperationType,
          user_id: person.userId,
          is_principal: person.isPrincipal,
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
      }),
    );

    return {
      people,
      catalogue: serviceRows.map((service) => ({
        id: service.id,
        name: resolveLocalizedText(service.name, locale, locale) ?? t("common.unnamed"),
        duration_minutes: service.durationMinutes,
      })),
    };
  });

  // Read outside the tenant transaction because `membership` is the one table
  // RLS does not cover; the organization filter is what scopes it. Only someone
  // who may manage specialists is shown who could be linked to one.
  const members = canManageCatalogue(membership.role, "commissions")
    ? await db
        .select({ user_id: memberships.userId, email: users.email, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.organizationId, membership.organizationId))
        .orderBy(asc(memberships.createdAt))
    : [];

  const canManage = canManageCatalogue(membership.role, "commissions");

  return (
    <main className="app-shell">
      <header className="app-header">
        {/*
          The compose action. Two shapes of the one control, exactly as the
          calendar's own toolbar and round button are (`app/app/calendar/page.tsx`):
          a labelled toggle for a desktop, a round one for a phone. Both point
          at the add-specialist `<details>` `components/specialist-manager.tsx`
          renders further down the page; the click handling that opens (and,
          for either anchor, closes) it lives there, since this is a Server
          Component and cannot hold it.
        */}
        {canManage && (
          <a className="primary-button calendar-create" href="#add-specialist">
            <ToolIcon name="plus" />
            {t("specialists.add")}
          </a>
        )}
        {canManage && (
          <a
            className="header-action"
            href="#add-specialist"
            aria-label={t("specialists.add")}
            data-label-closed={t("specialists.add")}
            data-label-open={t("specialists.hideAddTitle")}
          >
            <ToolIcon name="plus" />
            <ToolIcon name="minus" />
          </a>
        )}
      </header>
      <SpecialistManager
        specialists={people}
        services={catalogue}
        members={members}
        currency={currency}
        locale={locale}
        canManage={canManage}
      />
    </main>
  );
}
