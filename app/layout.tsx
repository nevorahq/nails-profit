import type { Metadata } from "next";
import { Onest } from "next/font/google";

import "./globals.css";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { resolveLocale } from "@/lib/locale";

const onest = Onest({
  subsets: ["cyrillic", "latin"],
  weight: "variable",
  display: "swap",
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
      <body className={onest.className}>
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
