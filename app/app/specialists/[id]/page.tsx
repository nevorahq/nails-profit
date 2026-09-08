import { asc, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";

import { SpecialistDetail } from "@/components/specialist-detail";
import { db } from "@/db";
import { memberships, services, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { loadSpecialistCards } from "@/lib/specialist-cards";
import { requireWorkspace } from "@/lib/workspace";

/**
 * One master's page: what the list used to carry in a row.
 *
 * The scope is the list's own. Section 6.1 limits a Master to their own card,
 * and here that has teeth it did not need in a table: a master who types
 * somebody else's id into the address bar is answered the same way as a master
 * from another studio — with a 404, because under RLS the row is not there to
 * be refused (section 6.2 asks that a refusal not confirm what exists).
 */
export default async function SpecialistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Not a uuid, so no row can match it. Answered before a query rather than by
  // one, and before the error a malformed uuid would raise inside the driver.
  if (!z.uuid().safeParse(id).success) notFound();

  const { membership, locale, currency, businessType } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "commissions", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("specialists.noAccess")}</p>
      </main>
    );
  }

  const ownOnly = scopeFor(membership.role, "commissions") === "own";
  const canManage = canManageCatalogue(membership.role, "commissions");

  const loaded = await withTenant(membership.organizationId, async (tx) => {
    const [person] = await loadSpecialistCards(tx, {
      id,
      ...(ownOnly ? { ownedBy: membership.userId } : {}),
    });
    if (!person) return null;

    const serviceRows = await tx
      .select()
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    return {
      person,
      catalogue: serviceRows.map((service) => ({
        id: service.id,
        name: resolveLocalizedText(service.name, locale, locale) ?? t("common.unnamed"),
        duration_minutes: service.durationMinutes,
      })),
    };
  });

  if (!loaded) notFound();

  /*
   * Accounts that could be linked to this card: everyone in the studio who has
   * no card of their own.
   *
   * Read outside the tenant transaction because `membership` is the one table
   * RLS does not cover; the organization filter is what scopes it. The list of
   * cards is read under RLS, which is what makes «already has one» a question
   * about this studio rather than about the whole table.
   */
  const linkableMembers =
    canManage && !loaded.person.user_id
      ? await (async () => {
          const taken = new Set(
            (await withTenant(membership.organizationId, (tx) => loadSpecialistCards(tx)))
              .map((card) => card.user_id)
              .filter((userId): userId is string => userId !== null),
          );
          const rows = await db
            .select({
              user_id: memberships.userId,
              email: users.email,
              role: memberships.role,
            })
            .from(memberships)
            .innerJoin(users, eq(memberships.userId, users.id))
            .where(eq(memberships.organizationId, membership.organizationId))
            .orderBy(asc(memberships.createdAt));
          return rows.filter((member) => !taken.has(member.user_id));
        })()
      : [];

  return (
    <SpecialistDetail
      person={loaded.person}
      services={loaded.catalogue}
      linkableMembers={linkableMembers}
      currency={currency}
      locale={locale}
      businessType={businessType}
      canManage={canManage}
    />
  );
}
