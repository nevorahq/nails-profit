import Link from "next/link";

import { getTranslator } from "@/i18n/t";
import { resolveLocale } from "@/lib/locale";

export default async function HomePage() {
  // No organization yet, so the language comes from the browser (LOC-008's
  // fallback). A visitor whose laptop is Romanian should not be met in Russian.
  const t = getTranslator(await resolveLocale());

  return (
    <main className="landing-shell">
      <nav className="topbar">
        <span className="brand">Nail Profit OS</span>
        <Link className="text-link" href="/login">
          {t("landing.login")}
        </Link>
      </nav>
      <section className="hero">
        <div className="eyebrow">{t("landing.eyebrow")}</div>
        <h1 style={{ whiteSpace: "pre-line" }}>{t("landing.hero")}</h1>
        <p>{t("landing.tagline")}</p>
        <Link className="primary-button" href="/login?mode=signup">
          {t("landing.start")}
        </Link>
      </section>
      <section className="metric-preview" aria-label={t("landing.exampleLabel")}>
        <div>
          <span>{t("landing.servicePrice")}</span>
          <strong>600 MDL</strong>
        </div>
        <div>
          <span>{t("landing.youKeep")}</span>
          <strong>325 MDL</strong>
        </div>
        <div>
          <span>{t("landing.perHour")}</span>
          <strong>216,67 MDL</strong>
        </div>
      </section>
      <footer className="legal-footer">
        <Link href="/privacy">{t("legal.privacyLink")}</Link>
        <Link href="/terms">{t("legal.termsLink")}</Link>
      </footer>
    </main>
  );
}
