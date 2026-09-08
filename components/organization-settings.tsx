"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { currencies, type Currency } from "@/domain/money";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";

/**
 * Language (LOC-001) and currency (LOC-006).
 *
 * Both are organization-wide rather than per-user: the interface language is a
 * property of the salon, and two masters looking at the same margin should be
 * reading the same words for it.
 */
/**
 * Endonyms, deliberately untranslated: someone looking for their own language
 * scans for the word they would write themselves, and a Romanian speaker
 * stranded in a Russian interface is looking for "Română", not "Румынский".
 */
const localeNames: Record<AppLocale, string> = {
  ru: "Русский",
  ro: "Română",
  en: "English",
};

/**
 * Currency names come from `Intl`, so they arrive in the reader's language
 * without a row in the dictionary to keep in step — with one exception.
 *
 * `Intl` spells RUB «российский рубль» in every style it offers (long, short
 * and narrow are the same string), and a studio keeping its books in roubles
 * calls it рубль. The override is a dictionary key rather than a literal here,
 * so the shorter name is shorter in all three interface languages instead of
 * turning the Romanian picker Russian.
 */
const SHORT_NAMES: Partial<Record<Currency, MessageKey>> = { RUB: "currency.rub" };

function currencyName(code: Currency, locale: AppLocale, t: Translate): string {
  const key = SHORT_NAMES[code];
  if (key) return `${code} — ${t(key)}`;

  const names = new Intl.DisplayNames([localeTag(locale)], { type: "currency" });
  return `${code} — ${names.of(code) ?? code}`;
}

export function OrganizationSettings({
  locale,
  currency,
  businessType,
  canEdit,
}: {
  locale: AppLocale;
  currency: string;
  /** Which of the two the reports address. Wording only; see `business-labels.ts`. */
  businessType: BusinessType;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  async function change(patch: { locale?: AppLocale; currency?: string; type?: BusinessType }) {
    setPending(true);
    setError(null);
    setSaved(false);

    const response = await fetch("/api/v1/organizations/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? "—");
      return;
    }
    setSaved(true);
    // The whole interface re-renders in the new language, so the server has to
    // produce it: the dictionary is chosen on the server, not in the browser.
    router.refresh();
  }

  return (
    <>
      <div className="add-form-toggle">
        {settingsOpen ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="btn-toggle-close" type="button" onClick={() => setSettingsOpen(false)} aria-label={t("common.cancel")}>−</button>
          </div>
        ) : (
          <button className="primary-button" type="button" style={{ width: "100%" }} onClick={() => setSettingsOpen(true)}>
            {t("settings.title")}
          </button>
        )}
      </div>
      <div className={`add-form-wrap${settingsOpen ? "" : " add-form-closed"}`}>
        <div className="add-form-inner">
    <section className="panel">
      <h2>{t("settings.title")}</h2>

      <div className="inline-form">
        <label>
          {t("settings.language")}
          <select
            value={locale}
            disabled={!canEdit || pending}
            onChange={(event) => change({ locale: event.target.value as AppLocale })}
          >
            {(Object.keys(localeNames) as AppLocale[]).map((option) => (
              <option key={option} value={option}>
                {localeNames[option]}
              </option>
            ))}
          </select>
        </label>

        <label>
          {t("settings.currency")}
          <select
            value={currency}
            disabled={!canEdit || pending}
            onChange={(event) => change({ currency: event.target.value })}
          >
            {currencies.map((option) => (
              <option key={option} value={option}>
                {currencyName(option, locale, t)}
              </option>
            ))}
          </select>
        </label>

        {/*
          «Формат работы», back — this is the "if it turns out they need it
          often enough to earn a control" the note here used to promise.

          It was removed as a setting an owner is asked to hold an opinion
          about before they have one, and for the first minute of an account
          that is still true; the signup form is where it is chosen and it now
          says there what it decides. What changed is everything after that
          minute. The type reaches far more of the product than it did — the
          first screen after registration, the service card, the four staff
          notifications, the heading «Мастера» sits under — so a woman who
          takes somebody on, or who picked «Студия» in a hurry, is now stuck
          with a product addressing the wrong person, and had nowhere at all to
          say so.

          One line under it and no paragraph of reassurance, which is what made
          this screen feel like a risk. The practical capacity rate stays away
          for the original reason: it is a number nobody has an opinion about,
          and it has a working default.
        */}
        <label>
          {t("workspace.format")}
          <select
            value={businessType}
            disabled={!canEdit || pending}
            onChange={(event) => change({ type: event.target.value as BusinessType })}
          >
            <option value="solo">{t("workspace.solo")}</option>
            <option value="studio">{t("workspace.studio")}</option>
          </select>
          <span className="field-hint">{t("workspace.formatHint")}</span>
        </label>
      </div>


      {/*
        The practical capacity rate is still not offered: it stays at the
        column's 75% default, which is the middle of the range the removed hint
        recommended anyway, and the cost of an hour and the utilization figure
        go on being computed from it. It remains editable through
        `PATCH /api/v1/organizations/settings`.
      */}

      {/* The booking address moved to «Онлайн-запись», next to the addresses it
          publishes and the switch that publishes them. It answers a question
          about that screen, and answering it three screens away is how it read
          as a general organization setting nobody had a reason to open. */}

      <div aria-live="polite" aria-atomic="true">
        {pending && <p className="muted">{t("common.saving")}</p>}
        {saved && !pending && <p className="muted">{t("settings.saved")}</p>}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!canEdit && <p className="warning-banner">{t("common.noAccess")}</p>}
    </section>
        </div>
      </div>
    </>
  );
}
