import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";

import { SpecialistDetail } from "@/components/specialist-detail";
import { db } from "@/db";
import { chairRents, memberships, services, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue, scopeFor, seesIndividualPay } from "@/domain/rbac";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { todayIn } from "@/domain/report-period";
import { formatLocalDate } from "@/domain/timezone";
import { registerOf } from "@/i18n/lexicon";
import { loadSpecialistCards } from "@/lib/specialist-cards";
import { loadBookabilityFacts } from "@/lib/specialist-bookability";
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

  const workspace = await requireWorkspace();
  const { membership, locale, currency, businessType, timezone } = workspace;
  const register = registerOf(workspace);
  const t = getTranslator(locale, register);

  if (!can(membership.role, "commissions", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("specialists.noAccess")}</p>
      </main>
    );
  }

  const ownOnly = scopeFor(membership.role, "commissions") === "own";
  const canManage = canManageCatalogue(membership.role, "commissions");
  // The same question the list asks, answered the same way — see its comment.
  const showsPay = seesIndividualPay(membership.role);
  const seesRent = can(membership.role, "expenses", "read");

  const loaded = await withTenant(membership.organizationId, async (tx) => {
    const [person] = await loadSpecialistCards(tx, {
      id,
      ...(ownOnly ? { ownedBy: membership.userId } : {}),
      withoutPay: !showsPay,
    });
    if (!person) return null;

    const serviceRows = await tx
      .select()
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    const bookability = await loadBookabilityFacts(tx);

    /*
     * The rent this person pays, current and scheduled — only for the owner,
     * through the capability that guards the ledger and the salaries: it is
     * the studio's income from one named person.
     */
    const now = new Date();
    const rents = seesRent
      ? await tx
          .select({ amountMinor: chairRents.amountMinor, activeFrom: chairRents.activeFrom })
          .from(chairRents)
          .where(
            and(
              eq(chairRents.specialistId, person.id),
              or(isNull(chairRents.activeTo), gt(chairRents.activeTo, now)),
            ),
          )
          .orderBy(asc(chairRents.activeFrom))
      : [];

    const inForce = rents.filter((rent) => rent.activeFrom.getTime() <= now.getTime()).at(-1) ?? null;
    const scheduled = rents.find((rent) => rent.activeFrom.getTime() > now.getTime()) ?? null;

    return {
      person,
      rent: seesRent
        ? {
            amount_minor: inForce?.amountMinor ?? null,
            scheduled: scheduled
              ? { amount_minor: scheduled.amountMinor, active_from: scheduled.activeFrom.toISOString() }
              : null,
          }
        : null,
      places: bookability.places.get(person.id) ?? [],
      publishedLocationIds: bookability.publishedLocationIds,
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
      rent={loaded.rent}
      services={loaded.catalogue}
      linkableMembers={linkableMembers}
      currency={currency}
      locale={locale}
      businessType={businessType}
      showsPay={showsPay}
      places={loaded.places}
      publishedLocationIds={loaded.publishedLocationIds}
      canManage={canManage}
      today={formatLocalDate(todayIn(new Date(), timezone))}
      timezone={timezone}
    />
  );
}
