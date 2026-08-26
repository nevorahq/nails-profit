import { asc, isNull } from "drizzle-orm";
import Link from "next/link";

import {
  addOns,
  clients,
  paymentMethods,
  serviceAddOns,
  services,
  specialists,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { VisitCloseForm, type CloseFormAddOn, type CloseFormService } from "@/components/visit-close-form";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator, type Translate } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

async function loadCatalogue(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  locale: string,
  t: Translate,
) {
  const serviceRows = await tx
    .select()
    .from(services)
    .where(isNull(services.archivedAt))
    .orderBy(asc(services.createdAt));

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

  return { catalogue, options };
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

  const data = await withTenant(membership.organizationId, async (tx) => {
    const { catalogue, options } = await loadCatalogue(tx, locale, t);
    const people = await tx
      .select({ id: specialists.id, name: specialists.name })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.createdAt));
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

    return { catalogue, options, people, clientRows, methods };
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
