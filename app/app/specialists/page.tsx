import { and, asc, eq, isNull } from "drizzle-orm";
import { AppNav } from "@/components/app-nav";

import { db } from "@/db";
import { commissionRules, memberships, services, specialists, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { selectCommissionRule } from "@/domain/commission";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { SpecialistManager, type SpecialistRow } from "@/components/specialist-manager";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function SpecialistsPage() {
  const { membership, organizationName, locale, currency } = await requireWorkspace();
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

    const people: SpecialistRow[] = await Promise.all(
      rows.map(async (person) => {
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
          default_rule: defaultRule
            ? {
                type: defaultRule.type,
                basis_points: defaultRule.basisPoints,
                fixed_amount_minor: defaultRule.fixedAmountMinor,
              }
            : null,
          service_exceptions: exceptions.map((rule) => ({
            service_id: rule.serviceId,
            type: rule.type,
            basis_points: rule.basisPoints,
            fixed_amount_minor: rule.fixedAmountMinor,
          })),
        };
      }),
    );

    return {
      people,
      catalogue: serviceRows.map((service) => ({
        id: service.id,
        name: resolveLocalizedText(service.name, locale, locale) ?? t("common.unnamed"),
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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("specialists.title")}</h1>
        </div>
        <AppNav active="/app/specialists" locale={locale} role={membership.role} />
      </header>
      <SpecialistManager
        specialists={people}
        services={catalogue}
        members={members}
        currency={currency}
        locale={locale}
        canManage={canManageCatalogue(membership.role, "commissions")}
      />
    </main>
  );
}
