import { asc, eq, isNull } from "drizzle-orm";

import { ToolIcon } from "@/components/icons";
import { db } from "@/db";
import { memberships, services, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { bookabilityOf } from "@/domain/bookability";
import { can, canManageCatalogue, scopeFor, seesIndividualPay } from "@/domain/rbac";
import { SpecialistManager } from "@/components/specialist-manager";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { loadSetupGuide } from "@/lib/onboarding";
import { loadSpecialistCards } from "@/lib/specialist-cards";
import { factsFor, loadBookabilityFacts } from "@/lib/specialist-bookability";
import { requireWorkspace } from "@/lib/workspace";

export default async function SpecialistsPage() {
  const { membership, locale, currency, businessType } = await requireWorkspace();
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

  /*
   * Whether this reader is owed what one named person is paid. An analyst is
   * not: section 6.1 gives them «Агрегаты», and until now they opened this
   * page to a table of every master's rate beside the address of their
   * account.
   */
  const showsPay = seesIndividualPay(membership.role);

  const { people, catalogue, unbookable } = await withTenant(membership.organizationId, async (tx) => {
    const cards = await loadSpecialistCards(tx, {
      ...(ownOnly ? { ownedBy: membership.userId } : {}),
      withoutPay: !showsPay,
    });

    const serviceRows = await tx
      .select()
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    /*
     * Who a client cannot reach yet. The two rows that decide it are written
     * on «Онлайн-запись»; this list is where the studio looks after hiring
     * somebody, and it answered four questions about a person without ever
     * answering that one.
     */
    const bookability = await loadBookabilityFacts(tx);
    const cannot = new Set(
      cards
        .filter(
          (person) =>
            bookabilityOf({
              publishedLocationIds: bookability.publishedLocationIds,
              ...factsFor(bookability.places.get(person.id)),
            }) !== "bookable",
        )
        .map((person) => person.id),
    );

    return {
      people: cards,
      unbookable: bookability.publishedLocationIds.length > 0 ? cannot : new Set<string>(),
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
        businessType={businessType}
        showsPay={showsPay}
        unbookable={unbookable}
        canManage={canManage}
        hasOwnCard={people.some((person) => person.user_id === membership.userId)}
        setupGuide={setupGuide}
      />
    </main>
  );
}
