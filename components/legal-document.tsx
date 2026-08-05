import Link from "next/link";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import type { LegalDocument as LegalDocumentContent } from "@/lib/legal-content";

export function LegalDocument({
  locale,
  title,
  version,
  document,
}: {
  locale: AppLocale;
  title: string;
  version: string;
  document: LegalDocumentContent;
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
          <p className="warning-banner">{t("legal.pilotReview")}</p>
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
      </article>
    </main>
  );
}

