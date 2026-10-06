import { redirect } from "next/navigation";

import { OpeningSetup } from "@/components/opening-setup";
import { clients } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { isPublicBookingEnabled } from "@/env";
import { canImport } from "@/lib/import-flow";
import { loadOpeningSetup } from "@/lib/opening-setup";
import { requireWorkspace } from "@/lib/workspace";

/**
 * «Ваш прайс и часы» — where `/app` sends an owner whose studio has not yet
 * confirmed what it opens with, and where «Проверить прайс и открыть запись»
 * leads back to afterwards.
 *
 * The owner's alone, as the endpoint it saves to is: the page asks `can()`
 * itself rather than trusting that nobody else was linked here.
 */
export default async function OpeningSetupPage() {
  const { membership, locale, currency, businessType } = await requireWorkspace();
  if (!can(membership.role, "organization_settings", "write")) redirect("/app");

  const { view, hasClients } = await withTenant(membership.organizationId, async (tx) => ({
    view: await loadOpeningSetup(tx, { organizationId: membership.organizationId, userId: membership.userId, locale }),
    // Archived ones count: a studio that has had clients is not starting out.
    hasClients: (await tx.select({ id: clients.id }).from(clients).limit(1)).length > 0,
  }));

  return (
    <OpeningSetup
      view={view}
      locale={locale}
      currency={currency}
      businessType={businessType}
      bookingAvailable={isPublicBookingEnabled()}
      offerClientImport={!hasClients && canImport(membership.role, "client")}
    />
  );
}
