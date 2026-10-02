import { resolveLocalizedText, type LocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";

/**
 * «Маникюр + Педикюр»: what a visit or an appointment was, read off its lines.
 *
 * Every list that names one used to take the first service line, which was the
 * only one. With several, the first alone would hide the pedicure from the
 * calendar, the visit list and the client's history alike. Null when no line
 * is a service, so each screen keeps its own word for «nothing to name».
 */
export function serviceNamesOf(
  lines: readonly Readonly<{ kind: string; nameSnapshot: LocalizedText | Record<string, string> }>[],
  locale: AppLocale,
): string | null {
  const names = lines
    .filter((line) => line.kind === "service")
    .map((line) => resolveLocalizedText(line.nameSnapshot as LocalizedText, locale, locale))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(" + ") : null;
}
