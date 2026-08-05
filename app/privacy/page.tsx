import { LegalDocument } from "@/components/legal-document";
import { getTranslator } from "@/i18n/t";
import { PRIVACY_VERSION } from "@/lib/legal";
import { privacyContent } from "@/lib/legal-content";
import { resolveLocale } from "@/lib/locale";

export default async function PrivacyPage() {
  const locale = await resolveLocale();
  const t = getTranslator(locale);

  return (
    <LegalDocument
      locale={locale}
      title={t("legal.privacyTitle")}
      version={PRIVACY_VERSION}
      document={privacyContent[locale]}
    />
  );
}

