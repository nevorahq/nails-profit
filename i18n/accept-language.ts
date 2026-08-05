import { supportedLocales, type AppLocale } from "@/i18n/messages";

/**
 * Reads the first supported language out of an `Accept-Language` header.
 *
 * Quality values are respected, because a browser that sends
 * `ro;q=0.9, ru;q=1.0` is stating a preference, and taking the first tag in
 * document order would invert it.
 */
export function localeFromHeader(header: string | null): AppLocale {
  if (!header) return "ru";

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter))
        .find(Boolean);
      return { tag: tag.toLowerCase(), quality: quality ? Number(quality[1]) : 1 };
    })
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    // `ro-MD` and `ro` both mean Romanian; the region is not our concern here.
    const base = tag.split("-")[0];
    const match = supportedLocales.find((locale) => locale === base);
    if (match) return match;
  }

  return "ru";
}
