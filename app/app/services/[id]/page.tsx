import { asc, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";

import { addOns, serviceAddOns, services, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { allocatedFixedCostMinor } from "@/domain/capacity";
import { can } from "@/domain/rbac";
import { ServiceDetail, type ServiceDetailData } from "@/components/service-detail";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { loadMaterials } from "@/lib/materials";
import { loadPeriodPL, monthOf } from "@/lib/period";
import { loadServiceCosting } from "@/lib/service-costing";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ add_ons?: string }>;
}) {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);
  const { id } = await params;
  // The chosen add-on set comes from the URL so the server can compute the
  // costing and a shared link reproduces the same numbers.
  const selectedAddOnIds = ((await searchParams).add_ons ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!can(membership.role, "services", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("services.noAccess")}</p>
      </main>
    );
  }

  const loaded = await withTenant(membership.organizationId, async (tx) => {
    // A service belonging to another organization is invisible under RLS, so
    // this becomes a 404 rather than revealing that the id exists (section 6.2).
    const [service] = await tx.select().from(services).where(eq(services.id, id)).limit(1);
    if (!service) return null;

    const [specialist] = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .orderBy(asc(specialists.createdAt), asc(specialists.id))
      .limit(1);

    const costing = await loadServiceCosting(tx, service, {
      specialistId: specialist?.id ?? null,
      addOnIds: selectedAddOnIds,
    });

    const catalogue = await tx
      .select()
      .from(addOns)
      .where(isNull(addOns.archivedAt))
      .orderBy(asc(addOns.createdAt));
    const linked = await tx
      .select({ addOnId: serviceAddOns.addOnId })
      .from(serviceAddOns)
      .where(eq(serviceAddOns.serviceId, service.id));

    /*
     * The Fully Loaded view, and only for someone allowed to see fixed costs.
     *
     * Rent and salaries are owner's data — the same capability the ledger and
     * the monthly report are behind — so a master sees the contribution margin
     * and no toggle at all rather than a rate that lets them work the rent out.
     *
     * It also costs four extra queries, which is the second reason not to run
     * it for every reader of the catalogue.
     */
    const showsFixedCosts =
      costing.status === "complete" &&
      costing.currency === currency &&
      can(membership.role, "expenses", "read");

    if (!showsFixedCosts) {
      return { service, costing, catalogue, linked: linked.map((row) => row.addOnId), fullyLoaded: null };
    }

    const month = monthOf(new Date());
    const report = await loadPeriodPL(
      tx,
      { month, currency, organizationId: membership.organizationId },
      locale,
    );
    const allocated = allocatedFixedCostMinor(
      report.capacity.fixedCostMinor,
      report.capacity.practicalMinutes,
      costing.costing.durationMinutes,
    );

    return {
      service,
      costing,
      catalogue,
      linked: linked.map((row) => row.addOnId),
      fullyLoaded:
        allocated === null || report.capacity.fixedCostRateMinorPerHour === null
          ? null
          : {
              month,
              allocated_fixed_cost_minor: allocated,
              fixed_cost_rate_minor_per_hour: report.capacity.fixedCostRateMinorPerHour,
            },
    };
  });

  if (!loaded) notFound();

  const materials = await loadMaterials(membership.organizationId);

  const data: ServiceDetailData = {
    id: loaded.service.id,
    name: loaded.service.name as Record<string, string>,
    price_minor: loaded.service.priceMinor,
    duration_minutes: loaded.service.durationMinutes,
    currency: loaded.service.currency,
    recipe: loaded.costing.lines.map((line) => ({
      material_id: line.materialId,
      material_name: line.materialName,
      base_unit: line.baseUnit,
      quantity_milli_units: line.quantityMilliUnits,
      cost_minor: line.costMinor,
    })),
    costing:
      loaded.costing.status === "complete"
        ? {
            status: "complete",
            formula_version: loaded.costing.costing.formulaVersion,
            currency: loaded.costing.currency,
            price_minor: loaded.costing.costing.priceMinor,
            duration_minutes: loaded.costing.costing.durationMinutes,
            material_cost_minor: loaded.costing.costing.materialCostMinor,
            commission_minor: loaded.costing.costing.commissionMinor,
            contribution_margin_minor: loaded.costing.costing.contributionMarginMinor,
            margin_basis_points: loaded.costing.costing.marginBasisPoints,
            profit_per_hour_minor: loaded.costing.costing.profitPerHourMinor,
          }
        : {
            status: "incomplete",
            reasons: [...loaded.costing.reasons],
            unpriced_material_ids: [...loaded.costing.unpricedMaterialIds],
          },
  };

  return (
    <ServiceDetail
      service={data}
      materials={materials}
      displayName={resolveLocalizedText(loaded.service.name, locale, locale) ?? t("common.unnamed")}
      addOns={loaded.catalogue.map((addOn) => ({
        id: addOn.id,
        displayName: resolveLocalizedText(addOn.name, locale, locale) ?? t("common.unnamed"),
        price_delta_minor: addOn.priceDeltaMinor,
        duration_delta_minutes: addOn.durationDeltaMinutes,
      }))}
      linkedAddOnIds={loaded.linked}
      selectedAddOnIds={selectedAddOnIds}
      fullyLoaded={loaded.fullyLoaded}
      locale={locale}
    />
  );
}
