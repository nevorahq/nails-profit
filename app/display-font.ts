import { Lora } from "next/font/google";

/**
 * The headline serif of the pages that wear the Mint System: the landing and
 * the sign-in card. One module, so the two routes share a single font
 * declaration instead of each carrying its own, and so the application screens
 * — which import neither — never download it. Lora rather than the Fraunces
 * named in DESIGN.md: Fraunces has no Cyrillic, and these pages are read in
 * Russian first.
 */
export const displayFont = Lora({
  subsets: ["cyrillic", "cyrillic-ext", "latin", "latin-ext"],
  weight: "variable",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-display",
});
