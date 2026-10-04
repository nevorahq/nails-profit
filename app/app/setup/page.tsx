import { redirect } from "next/navigation";

import { OpeningSetup } from "@/components/opening-setup";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { isPublicBookingEnabled } from "@/env";
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

  const view = await withTenant(membership.organizationId, (tx) =>
    loadOpeningSetup(tx, { organizationId: membership.organizationId, userId: membership.userId, locale }),
  );

  return (
    <OpeningSetup
      view={view}
      locale={locale}
      currency={currency}
      businessType={businessType}
      bookingAvailable={isPublicBookingEnabled()}
    />
  );
}
