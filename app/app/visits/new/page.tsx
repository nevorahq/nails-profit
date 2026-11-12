import { and, asc, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import Link from "next/link";

import {
  addOns,
  clients,
  commissionRules,
  paymentMethods,
  serviceAddOns,
  services,
  specialistServices,
  specialists,
} from "@/db/schema";
import { instantLiteral } from "@/db/literal";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { VisitCloseForm, type CloseFormAddOn, type CloseFormService } from "@/components/visit-close-form";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator, type Translate } from "@/i18n/t";
import { registerOf } from "@/i18n/lexicon";
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
  // The three catalogue reads go to the database together, as one flight.
  const [allServices, addOnRows, links] = await Promise.all([
    tx.select().from(services).where(isNull(services.archivedAt)).orderBy(asc(services.createdAt)).execute(),
    tx.select().from(addOns).where(isNull(addOns.archivedAt)).execute(),
    tx.select().from(serviceAddOns).execute(),
  ]);

  const serviceRows = allServices.filter(
    (service): service is typeof service & { priceMinor: number; durationMinutes: number } =>
      service.priceMinor !== null && service.durationMinutes !== null,
  );
  const unusableServices = allServices.length - serviceRows.length;


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
  const workspace = await requireWorkspace();
  const { membership, locale, currency } = workspace;
  const register = registerOf(workspace);
  const t = getTranslator(locale, register);

  if (!can(membership.role, "bookings", "write")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("closeVisit.noAccess")}</p>
      </main>
    );
  }

  const data = await withTenant(membership.organizationId, async (tx) => {
    /*
     * Everything the form needs is started at once and awaited together. The
     * reads share this transaction, so the server answers them in turn, but
     * none carries a parameter — `now` is written into the text, see
     * `db/literal.ts` — and the driver sends them as one flight rather than
     * waiting a round trip between each.
     */
    const catalogueRead = loadCatalogue(tx, locale, t);

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
    const ruleRowsRead = tx
      .select({
        specialistId: commissionRules.specialistId,
        serviceId: commissionRules.serviceId,
      })
      .from(commissionRules)
      .where(
        and(
          lte(commissionRules.activeFrom, instantLiteral(now)),
          or(isNull(commissionRules.activeTo), gt(commissionRules.activeTo, instantLiteral(now))),
        ),
      )
      .execute();

    const rowsRead = tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.createdAt))
      .execute();

    // Each master's own prices, so the total the form shows is what will be recorded.
    const ownPricesRead = tx
      .select({
        specialistId: specialistServices.specialistId,
        serviceId: specialistServices.serviceId,
        priceMinor: specialistServices.priceOverrideMinor,
      })
      .from(specialistServices)
      .where(isNotNull(specialistServices.priceOverrideMinor))
      .execute();

    const clientRowsRead = tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(isNull(clients.archivedAt))
      .orderBy(asc(clients.name))
      .execute();

    const methodsRead = tx
      .select({
        id: paymentMethods.id,
        name: paymentMethods.name,
        is_default: paymentMethods.isDefault,
      })
      .from(paymentMethods)
      .where(isNull(paymentMethods.archivedAt))
      .orderBy(asc(paymentMethods.createdAt))
      .execute();

    const [{ catalogue, options, unusableServices }, ruleRows, rows, ownPrices, clientRows, methods] =
      await Promise.all([catalogueRead, ruleRowsRead, rowsRead, ownPricesRead, clientRowsRead, methodsRead]);

    const people = rows.map((person) => {
      const mine = ruleRows.filter((rule) => rule.specialistId === person.id);
      return {
        id: person.id,
        name: person.name,
        price_by_service: Object.fromEntries(
          ownPrices
            .filter((row) => row.specialistId === person.id)
            .map((row) => [row.serviceId, row.priceMinor as number]),
        ),
        covered_service_ids: mine.some((rule) => rule.serviceId === null)
          ? null
          : mine
              .map((rule) => rule.serviceId)
              .filter((id): id is string => id !== null),
      };
    });
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
      />
    </main>
  );
}
