"use client";

import type { AppLocale } from "@/i18n/messages";
import { useTranslator } from "@/components/lexicon-provider";

/** The export. Deleting the studio is in the danger zone, at the bottom of the page. */
export function DataManagement({ locale, canExport }: { locale: AppLocale; canExport: boolean }) {
  const t = useTranslator(locale);

  return (
    <section className="panel" aria-labelledby="data-management-title">
      <h2 id="data-management-title">{t("settings.dataTitle")}</h2>
      <p className="muted">{t("settings.dataHint")}</p>

      {canExport ? (
        <a className="secondary-button" href="/api/v1/organizations/export" download>
          {t("settings.export")}
        </a>
      ) : (
        <p className="warning-banner">{t("settings.ownerOnly")}</p>
      )}
    </section>
  );
}
