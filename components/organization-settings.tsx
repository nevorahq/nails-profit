"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { PublicAddressEditor } from "@/components/public-address-editor";
import { currencies, type Currency } from "@/domain/money";
import { ORGANIZATION_NAME_PATTERN } from "@/domain/organization-name";
import { checkSlug, slugify } from "@/domain/slug";
import type { AppLocale } from "@/i18n/messages";
import { type MessageKey, type Translate } from "@/i18n/t";
import { useTranslator } from "@/components/lexicon-provider";
import { localeNames } from "@/i18n/locale-names";
import { localeTag } from "@/i18n/translate";

/**
 * Language (LOC-001) and currency (LOC-006).
 *
 * Both are organization-wide rather than per-user: the interface language is a
 * property of the salon, and two masters looking at the same margin should be
 * reading the same words for it.
 */
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

/** The two audiences `staffNoticeAudience` allows. */
type StaffNotices = "owner" | "owner_and_managers";

export function OrganizationSettings({
  name,
  slug,
  locale,
  currency,
  staffNotices,
  detailedAnalytics,
  canEdit,
  startOpen = false,
}: {
  /** What clients read on the booking page and the studio reads in the topbar. */
  name: string;
  /** The booking page's address, `/book/<slug>`. */
  slug: string | null;
  locale: AppLocale;
  currency: string;
  /** Who besides the working master hears about a booking. */
  staffNotices: StaffNotices;
  /** «Подробная финансовая аналитика» — see the column in `db/schema.ts`. */
  detailedAnalytics: boolean;
  canEdit: boolean;
  startOpen?: boolean;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open from the start when «Изменить название студии» on «Онлайн-запись»
  // sent the owner here: a link that lands on a folded panel lands nowhere.
  const [settingsOpen, setSettingsOpen] = useState(startOpen);
  /**
   * The link a rename suggests, offered rather than applied.
   *
   * Sign-up derives the booking link from the name, so somebody fixing a name
   * typed in a hurry expects the link to follow — and it must not do that by
   * itself, because the old link may already be on an Instagram profile. The
   * question is put once, after the rename, with the warning beside it.
   */
  const [suggestedSlug, setSuggestedSlug] = useState<string | null>(null);

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get("studio_name") ?? "").trim();
    setPending(true);
    setError(null);
    setSaved(false);

    const response = await fetch("/api/v1/organizations/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(
        body?.error?.code === "VALIDATION_ERROR"
          ? t("settings.studioNameInvalid")
          : (body?.error?.message ?? t("common.saveFailed")),
      );
      return;
    }

    setSaved(true);
    if (next === name) return;
    const candidate = slugify(next);
    setSuggestedSlug(candidate !== slug && checkSlug(candidate) === null ? candidate : null);
    router.refresh();
  }

  async function change(patch: {
    locale?: AppLocale;
    currency?: string;
    staff_notices?: StaffNotices;
    detailed_analytics?: boolean;
  }) {
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

      {/*
        The studio's own name, which sign-up asks for and which nothing let
        anybody change afterwards. The «Название» on an address card in
        «Онлайн-запись» looked like the place, and renamed only that address.
        Same rule as at sign-up: Latin, because clients read it on the link's
        page, and the browser refuses the rest before the server has to.
      */}
      <form id="studio-name" className="inline-form" onSubmit={rename}>
        <label>
          {t("settings.studioName")}
          {/* Uncontrolled, and read from the form on submit: a name typed
              before the page finished loading is still the name sent. Keyed
              on the saved name so a rename resets it to what was stored. */}
          <input
            key={name}
            name="studio_name"
            defaultValue={name}
            required
            minLength={2}
            maxLength={100}
            pattern={ORGANIZATION_NAME_PATTERN.source.slice(1, -1)}
            title={t("auth.studioNameLatin")}
            disabled={!canEdit || pending}
          />
          <span className="field-hint">{t("auth.studioNameLatin")}</span>
        </label>
        <button
          className="secondary-button"
          type="submit"
          disabled={!canEdit || pending}
        >
          {t("settings.studioNameSave")}
        </button>
      </form>
      {suggestedSlug && slug && (
        <div>
          <p className="muted">{t("settings.slugSuggestion", { link: `/book/${slug}` })}</p>
          <PublicAddressEditor
            slug={slug}
            locale={locale}
            canEdit={canEdit}
            suggested={suggestedSlug}
            onDone={() => setSuggestedSlug(null)}
          />
        </div>
      )}

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
          Who hears about a booking, decided by the studio rather than by us.

          The master whose chair it is always hears; this is about everybody
          else, and it was the owner and nobody but the owner — leaving out the
          one role whose whole job is to answer, since a manager runs the front
          desk and holds `bookings` at «Да». Making it a rule instead would
          have been wrong in the other direction: one message goes per
          recipient, so a studio with two administrators would get four emails
          for one request. Whoever knows how the shift actually works is the
          one who should be weighing that.
        */}
        <label>
          {t("settings.staffNotices")}
          <select
            value={staffNotices}
            disabled={!canEdit || pending}
            onChange={(event) => change({ staff_notices: event.target.value as StaffNotices })}
          >
            <option value="owner">{t("settings.staffNotices.owner")}</option>
            <option value="owner_and_managers">
              {t("settings.staffNotices.owner_and_managers")}
            </option>
          </select>
        </label>

        {/*
          «Формат работы» is not offered here any more, and nothing replaced it
          on the screen: the product now works the answer out for itself.

          It was a control asking an owner to hold an opinion about a word. The
          two events that make «оплата труда мастеров» true are events the
          product already witnesses — a second master catalogued, or a master
          accepting an invitation — and `lib/solo-mode.ts` acts on either. A
          woman who takes somebody on is addressed correctly the same day,
          without having to know this screen exists.

          The type is still a column and still writable through
          `PATCH /api/v1/organizations/settings`, which is the way back for a
          studio that shrank, or for one that was picked in a hurry at signup.
        */}
      </div>


      {/*
        The owner's to choose, like the rest of this panel: the endpoint asks
        `can(…, "organization_settings", "write")` again, so a manager who
        reached this control would be refused by the server, not by the
        disabled attribute.
      */}
      <div className="inline-form">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={detailedAnalytics}
            disabled={!canEdit || pending}
            onChange={(event) => change({ detailed_analytics: event.target.checked })}
          />
          {t("settings.detailedAnalytics")}
        </label>
      </div>
      <p className="muted">{t("settings.detailedAnalyticsHint")}</p>

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
