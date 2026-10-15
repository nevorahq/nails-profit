import Link from "next/link";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import type { LegalDocument as LegalDocumentContent } from "@/lib/legal-content";

export function LegalDocument({
  locale,
  title,
  version,
  document,
  operator,
}: {
  locale: AppLocale;
  title: string;
  version: string;
  document: LegalDocumentContent;
  /** Who is selling and where to write; either may be missing. */
  operator: { name: string | null; email: string | null };
}) {
  const t = getTranslator(locale);

  return (
    <main className="legal-shell">
      <Link className="text-link" href="/">
        ← {t("legal.back")}
      </Link>
      <article className="legal-document">
        <header>
          <span className="eyebrow">Nail Profit OS</span>
          <h1>{title}</h1>
          <p className="muted">{t("legal.updated", { date: version })}</p>
          <p>{document.intro}</p>
        </header>
        {document.sections.map((section) => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {section.bullets && (
              <ul>
                {section.bullets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {operator.name || operator.email ? (
          <section>
            <h2>{t("legal.operator")}</h2>
            {operator.name ? <p>{operator.name}</p> : null}
            {operator.email ? (
              <p>
                {t("legal.contact")}: <a href={`mailto:${operator.email}`}>{operator.email}</a>
              </p>
            ) : null}
          </section>
        ) : null}
        <nav className="legal-links" aria-label={t("legal.operator")}>
          <Link href="/terms">{t("legal.termsTitle")}</Link>
          <Link href="/privacy">{t("legal.privacyTitle")}</Link>
          <Link href="/refund">{t("legal.refundTitle")}</Link>
        </nav>
      </article>
    </main>
  );
}

