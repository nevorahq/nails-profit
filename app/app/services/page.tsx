import { asc, isNull } from "drizzle-orm";
import Link from "next/link";

import { services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { ServiceList, type ServiceRow } from "@/components/service-list";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { loadServiceCosting } from "@/lib/service-costing";
import { requireWorkspace } from "@/lib/workspace";

export default async function ServicesPage() {
  const { membership, organizationName, locale } = await requireWorkspace();

  if (!can(membership.role, "services", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">У вашей роли нет доступа к услугам.</p>
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
          displayName: resolveLocalizedText(service.name, locale, locale) ?? "Без названия",
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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>Услуги</h1>
        </div>
        <nav className="tab-nav">
          <Link className="active" href="/app/services">
            Услуги
          </Link>
          <Link href="/app/add-ons">Опции</Link>
          <Link href="/app/materials">Материалы</Link>
          <Link href="/app/specialists">Мастера</Link>
        </nav>
      </header>
      <ServiceList services={rows} locale={locale} />
    </main>
  );
}
