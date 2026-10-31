import { Playfair } from "next/font/google";

import { LandingExperience } from "@/components/landing-experience";
import { getSupportEmail } from "@/env";
import { resolveLocale } from "@/lib/locale";

/**
 * The landing's headline serif, loaded here rather than in the root layout so
 * the application screens never download it. Playfair rather than the
 * Fraunces named in DESIGN.md: Fraunces has no Cyrillic, and the landing is
 * read in Russian first.
 */
const display = Playfair({
  subsets: ["cyrillic", "cyrillic-ext", "latin", "latin-ext"],
  weight: "variable",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-display",
});

export default async function HomePage() {
  return <LandingExperience locale={await resolveLocale()} supportEmail={getSupportEmail()} displayFont={display.variable} />;
}
