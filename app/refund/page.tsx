import { LegalDocument } from "@/components/legal-document";
import { getLegalEntityName, getSupportEmail } from "@/env";
import { getTranslator } from "@/i18n/t";
import { REFUND_VERSION } from "@/lib/legal";
import { refundContent } from "@/lib/legal-content";
import { resolveLocale } from "@/lib/locale";

export default async function RefundPage() {
  const locale = await resolveLocale();
  const t = getTranslator(locale);

  return (
    <LegalDocument
      locale={locale}
      title={t("legal.refundTitle")}
      version={REFUND_VERSION}
      document={refundContent[locale]}
      operator={{ name: getLegalEntityName(), email: getSupportEmail() }}
    />
  );
}
