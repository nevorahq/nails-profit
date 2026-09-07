import { asc, eq, isNull } from "drizzle-orm";

import { ToolIcon } from "@/components/icons";
import { db } from "@/db";
import { memberships, services, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { SpecialistManager } from "@/components/specialist-manager";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { loadSetupGuide } from "@/lib/onboarding";
import { loadSpecialistCards } from "@/lib/specialist-cards";
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
    const cards = await loadSpecialistCards(tx, ownOnly ? { ownedBy: membership.userId } : {});

    const serviceRows = await tx
      .select()
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    return {
      people: cards,
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
        .select({
          user_id: memberships.userId,
          email: users.email,
          // The name the account signed up with, so a card created for them is
          // called what the studio calls them rather than by their address.
          name: users.name,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.organizationId, membership.organizationId))
        .orderBy(asc(memberships.createdAt))
    : [];

  const canManage = canManageCatalogue(membership.role, "commissions");

  /*
   * Whether this page is a stop on a guided first run, and what the checklist
   * stood at when it was drawn. Null — one count — for everybody who has closed
   * a visit, which is every studio past its first day.
   */
  const setupGuide = canManageCatalogue(membership.role, "services")
    ? await withTenant(membership.organizationId, (tx) => loadSetupGuide(tx))
    : null;

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
        hasOwnCard={people.some((person) => person.user_id === membership.userId)}
        setupGuide={setupGuide}
      />
    </main>
  );
}
