import { asc, isNull } from "drizzle-orm";

import { ToolIcon } from "@/components/icons";
import { addOns } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { AddOnCatalogue, type AddOnRow } from "@/components/add-on-catalogue";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

export default async function AddOnsPage() {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  if (!can(membership.role, "services", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("services.noAccess")}</p>
      </main>
    );
  }

  const rows: AddOnRow[] = await withTenant(membership.organizationId, async (tx) => {
    const catalogue = await tx
      .select()
      .from(addOns)
      .where(isNull(addOns.archivedAt))
      .orderBy(asc(addOns.createdAt));

    return catalogue.map((addOn) => ({
      id: addOn.id,
      displayName: resolveLocalizedText(addOn.name, locale, locale) ?? t("common.unnamed"),
      price_delta_minor: addOn.priceDeltaMinor,
      duration_delta_minutes: addOn.durationDeltaMinutes,
    }));
  });

  const canManage = canManageCatalogue(membership.role, "services");

  return (
    <main className="app-shell">
      <header className="app-header">
        {/*
          The compose action. Two shapes of the one control, exactly as the
          calendar's own toolbar and round button are (`app/app/calendar/page.tsx`):
          a labelled toggle for a desktop, a round one for a phone. Both point
          at the add-on `<details>` `components/add-on-catalogue.tsx` renders
          further down the page; the click handling that opens (and, for
          either anchor, closes) it lives there, since this is a Server
          Component and cannot hold it.
        */}
        {canManage && (
          <a className="primary-button calendar-create" href="#add-addon">
            <ToolIcon name="plus" />
            {t("addOns.add")}
          </a>
        )}
        {canManage && (
          <a
            className="header-action"
            href="#add-addon"
            aria-label={t("addOns.add")}
            data-label-closed={t("addOns.add")}
            data-label-open={t("addOns.hideAddTitle")}
          >
            <ToolIcon name="plus" />
            <ToolIcon name="minus" />
          </a>
        )}
      </header>
      <AddOnCatalogue
        addOns={rows}
        currency={currency}
        locale={locale}
        canManage={canManage}
      />
    </main>
  );
}
