"use client";

import { useTranslator } from "@/components/lexicon-provider";
import type { AppLocale } from "@/i18n/messages";

/**
 * «С даты» — the one field «Изменить с даты» adds to a rule's form.
 *
 * Today by default and no earlier: the endpoints refuse a day gone by
 * (`domain/rule-change.ts`), and the browser refusing it first means the owner
 * never meets that refusal. `today` is the studio's own date, worked out on the
 * server from its timezone — the browser's clock can be a day off from it for
 * somebody setting up a studio from another country.
 *
 * The line under it is the promise the versioning keeps, said where the change
 * is made: what was already counted stays counted.
 */
export function EffectiveDateField({ today, locale }: { today: string; locale: AppLocale }) {
  const t = useTranslator(locale);

  return (
    <>
      <label>
        {t("rules.from")}
        <input name="effective_date" type="date" defaultValue={today} min={today} required />
      </label>
      <p className="field-hint rule-date-note">{t("rules.pastUnchanged")}</p>
    </>
  );
}

/** What the form posts: the day, or nothing when it is today — which the server reads as now. */
export function effectiveDateFrom(data: FormData, today: string): { effective_date?: string } {
  const value = String(data.get("effective_date") ?? "").trim();
  return value && value !== today ? { effective_date: value } : {};
}
