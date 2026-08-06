"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
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

const currencies = ["MDL", "EUR"] as const;

/**
 * Currency names come from `Intl`, so they arrive in the reader's language
 * without a third row in the dictionary to keep in step.
 */
function currencyName(code: string, locale: AppLocale): string {
  const names = new Intl.DisplayNames([localeTag(locale)], { type: "currency" });
  return `${code} — ${names.of(code) ?? code}`;
}

export function OrganizationSettings({
  locale,
  currency,
  slug,
  canEdit,
}: {
  locale: AppLocale;
  currency: string;
  slug: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicSlug, setPublicSlug] = useState(slug ?? "");

  async function change(patch: { locale?: AppLocale; currency?: string; slug?: string | null }) {
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
                {currencyName(option, locale)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="muted">{t("settings.languageHint")}</p>
      <p className="muted">{t("settings.currencyHint")}</p>

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void change({ slug: publicSlug.trim() || null });
        }}
      >
        <label>
          {t("settings.bookingSlug")}
          <input
            value={publicSlug}
            disabled={!canEdit || pending}
            placeholder="studio-name"
            autoComplete="off"
            onChange={(event) => setPublicSlug(event.target.value.toLowerCase())}
          />
        </label>
        <button className="secondary-button" type="submit" disabled={!canEdit || pending}>
          {t("settings.bookingSlugSave")}
        </button>
      </form>
      <p className="muted">{t("settings.bookingSlugHint")}</p>
      {slug && (
        <a className="text-link" href={`/book/${slug}`} target="_blank" rel="noreferrer">
          /book/{slug}
        </a>
      )}

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
  );
}
