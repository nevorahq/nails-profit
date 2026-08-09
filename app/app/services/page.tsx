import { asc, isNull } from "drizzle-orm";

import { ToolIcon } from "@/components/icons";
import { services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { ServiceList, type ServiceRow } from "@/components/service-list";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { loadServiceCosting } from "@/lib/service-costing";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function ServicesPage() {
  const { membership, locale } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "services", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("services.noAccess")}</p>
      </main>
    );
  }

  const rows: ServiceRow[] = await withTenant(membership.organizationId, async (tx) => {
    const [specialist] = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.createdAt), asc(specialists.id))
      .limit(1);

    const catalogue = await tx
      .select()
      .from(services)
      .where(isNull(services.archivedAt))
      .orderBy(asc(services.createdAt));

    return Promise.all(
      catalogue.map(async (service) => {
        const costing = await loadServiceCosting(tx, service, { specialistId: specialist?.id ?? null });
        return {
          id: service.id,
          displayName: resolveLocalizedText(service.name, locale, locale) ?? t("common.unnamed"),
          price_minor: service.priceMinor,
          duration_minutes: service.durationMinutes,
          currency: service.currency,
          costing:
            costing.status === "complete"
              ? {
                  status: "complete" as const,
                  contribution_margin_minor: costing.costing.contributionMarginMinor,
                  margin_basis_points: costing.costing.marginBasisPoints,
                  profit_per_hour_minor: costing.costing.profitPerHourMinor,
                }
              : { status: "incomplete" as const, reasons: [...costing.reasons] },
        };
      }),
    );
  });

  const canWrite = can(membership.role, "services", "write");

  return (
    <main className="app-shell">
      <header className="app-header">
        {/*
          The compose action. Two shapes of the one control, exactly as the
          calendar's own toolbar and round button are (`app/app/calendar/page.tsx`):
          a labelled toggle for a desktop, a round one for a phone. Both point
          at the add-service `<details>` `components/service-list.tsx` renders
          further down the page; the click handling that opens (and, for
          either anchor, closes) it lives there, since this is a Server
          Component and cannot hold it.
        */}
        {canWrite && (
          <a className="primary-button calendar-create" href="#add-service">
            <ToolIcon name="plus" />
            {t("services.add")}
          </a>
        )}
        {canWrite && (
          <a
            className="header-action"
            href="#add-service"
            aria-label={t("services.add")}
            data-label-closed={t("services.add")}
            data-label-open={t("services.hideAddTitle")}
          >
            <ToolIcon name="plus" />
            <ToolIcon name="minus" />
          </a>
        )}
      </header>
      <ServiceList services={rows} locale={locale} />
    </main>
  );
}
