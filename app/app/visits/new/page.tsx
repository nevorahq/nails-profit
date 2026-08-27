import { and, asc, gt, isNull, lte, or } from "drizzle-orm";
import Link from "next/link";

import {
  addOns,
  clients,
  commissionRules,
  paymentMethods,
  serviceAddOns,
  services,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { VisitCloseForm, type CloseFormAddOn, type CloseFormService } from "@/components/visit-close-form";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator, type Translate } from "@/i18n/t";
import { loadSetupGuide } from "@/lib/onboarding";
import { requireWorkspace } from "@/lib/workspace";

async function loadCatalogue(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  locale: string,
  t: Translate,
) {
  /*
   * Only the services that can actually be closed.
   *
   * A service with no price or no duration used to be offered here like any
   * other: the form previewed it as «0 за 0 мин» — reading `?? 0` for both —
   * and the server refused the visit with MISSING_DURATION once the whole thing
   * had been filled in. The refusal is right and stays; what changes is that it
   * is no longer reached by choosing a row the screen offered. How many were
   * left out is counted, because a service that has quietly vanished from the
   * list is its own kind of confusing.
   */
  const allServices = await tx
    .select()
    .from(services)
    .where(isNull(services.archivedAt))
    .orderBy(asc(services.createdAt));

  const serviceRows = allServices.filter(
    (service): service is typeof service & { priceMinor: number; durationMinutes: number } =>
      service.priceMinor !== null && service.durationMinutes !== null,
  );
  const unusableServices = allServices.length - serviceRows.length;

  const addOnRows = await tx.select().from(addOns).where(isNull(addOns.archivedAt));
  const links = await tx.select().from(serviceAddOns);

  const catalogue: CloseFormService[] = serviceRows.map((service) => ({
    id: service.id,
    displayName: resolveLocalizedText(service.name, locale as "ru", locale as "ru") ?? t("common.unnamed"),
    price_minor: service.priceMinor,
    duration_minutes: service.durationMinutes,
  }));

  const options: CloseFormAddOn[] = addOnRows.map((addOn) => ({
    id: addOn.id,
    displayName: resolveLocalizedText(addOn.name, locale as "ru", locale as "ru") ?? t("common.unnamed"),
    price_delta_minor: addOn.priceDeltaMinor,
    duration_delta_minutes: addOn.durationDeltaMinutes,
    serviceIds: links.filter((link) => link.addOnId === addOn.id).map((link) => link.serviceId),
  }));

  return { catalogue, options, unusableServices };
}

export default async function NewVisitPage() {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "bookings", "write")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("closeVisit.noAccess")}</p>
      </main>
    );
  }

  /*
   * The last stop of the guided run, and the only one where the window says
   * «готово» rather than «осталось». Null for anybody who has closed a visit
   * before — including, one moment later, this very studio.
   */
  const setupGuide = canManageCatalogue(membership.role, "services")
    ? await withTenant(membership.organizationId, (tx) => loadSetupGuide(tx))
    : null;

  const data = await withTenant(membership.organizationId, async (tx) => {
    const { catalogue, options, unusableServices } = await loadCatalogue(tx, locale, t);

    /*
     * Who can be paid for what, which is the other half of the same problem.
     *
     * `recordCompletedVisit` refuses with MISSING_COMMISSION_RULE when the
     * specialist has no rule in force for the service worked, and that is the
     * one refusal a first-time studio meets most: the master was added, the
     * rule was not. The rules in force are read here and the form is told which
     * services each person is covered for, so the answer is on screen before
     * the visit is written rather than after.
     *
     * `null` means every service — a rule with no `service_id`, which is what
     * almost every studio writes. A list means the person has only per-service
     * exceptions; an empty list means no rule at all.
     */
    const now = new Date();
    const ruleRows = await tx
      .select({
        specialistId: commissionRules.specialistId,
        serviceId: commissionRules.serviceId,
      })
      .from(commissionRules)
      .where(
        and(
          lte(commissionRules.activeFrom, now),
          or(isNull(commissionRules.activeTo), gt(commissionRules.activeTo, now)),
        ),
      );

    const rows = await tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.createdAt));

    const people = rows.map((person) => {
      const mine = ruleRows.filter((rule) => rule.specialistId === person.id);
      return {
        id: person.id,
        name: person.name,
        covered_service_ids: mine.some((rule) => rule.serviceId === null)
          ? null
          : mine
              .map((rule) => rule.serviceId)
              .filter((id): id is string => id !== null),
      };
    });
    const clientRows = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(isNull(clients.archivedAt))
      .orderBy(asc(clients.name));

    const methods = await tx
      .select({
        id: paymentMethods.id,
        name: paymentMethods.name,
        is_default: paymentMethods.isDefault,
      })
      .from(paymentMethods)
      .where(isNull(paymentMethods.archivedAt))
      .orderBy(asc(paymentMethods.createdAt));

    return { catalogue, options, unusableServices, people, clientRows, methods };
  });

  return (
    <main className="app-shell">
      <header className="app-header app-header-split">
        <h1>{t("closeVisit.title")}</h1>
        <Link className="text-link" href="/app/visits">
          ← {t("visits.title")}
        </Link>
      </header>
      <VisitCloseForm
        services={data.catalogue}
        unusableServices={data.unusableServices}
        addOns={data.options}
        specialists={data.people}
        clients={data.clientRows}
        paymentMethods={data.methods}
        currency={currency}
        locale={locale}
        setupGuide={setupGuide}
      />
    </main>
  );
}
