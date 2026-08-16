import type { Metadata } from "next";
import { Onest } from "next/font/google";

import "./globals.css";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { resolveLocale } from "@/lib/locale";

/**
 * `variable` as well as the class, because the stylesheet asks for the family
 * by name: `.marketing-page` sets `font-family: var(--font-onest), Arial,
 * sans-serif`. Without this the variable was never declared, so that
 * declaration was invalid at computed-value time and the landing page inherited
 * Onest from `<body>` instead — right on screen, by accident, with `Arial`
 * unreachable and any element that did not inherit left to the browser default.
 *
 * next/font resolves the variable to `Onest, "Onest Fallback"`, the second name
 * being the metric-matched local face it generates so that swapping in the web
 * font does not shift the layout.
 */
const onest = Onest({
  subsets: ["cyrillic", "latin"],
  weight: "variable",
  display: "swap",
  variable: "--font-onest",
});

/** LOC-002: the tab title and description follow the interface language too. */
export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslator(await resolveLocale());
  return { title: "Nail Profit OS", description: t("app.description") };
}

/**
 * LOC-002: `<html lang>` follows the interface language. Screen readers pick
 * pronunciation from it, so a Romanian interface tagged `ru` is read aloud with
 * Russian phonetics.
 */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await resolveLocale();
  const t = getTranslator(locale);

  return (
    <html lang={localeTag(locale)}>
      <body className={`${onest.variable} ${onest.className}`}>
        <a className="skip-link" href="#main-content">
          {t("common.skipToContent")}
        </a>
        <div id="main-content" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  );
}
