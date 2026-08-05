import { LegalDocument } from "@/components/legal-document";
import { getTranslator } from "@/i18n/t";
import { TERMS_VERSION } from "@/lib/legal";
import { termsContent } from "@/lib/legal-content";
import { resolveLocale } from "@/lib/locale";

export default async function TermsPage() {
  const locale = await resolveLocale();
  const t = getTranslator(locale);

  return (
    <LegalDocument
      locale={locale}
      title={t("legal.termsTitle")}
      version={TERMS_VERSION}
      document={termsContent[locale]}
    />
  );
}

