"use client";

import { FormEvent, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

import { currencies, type Currency } from "@/domain/money";
import { catalogueEntry } from "@/domain/service-catalogue";
import {
  currencyForTimezone,
  DEFAULT_COMMISSION_PERCENT,
  DEFAULT_SERVICE,
  DEFAULT_WORKWEEK,
} from "@/domain/workspace-defaults";
import type { BusinessType } from "@/i18n/business-labels";
import { getErrorMessage, supportedLocales, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * The studio, registered in one press.
 *
 * This screen used to ask four questions and hand back a workspace that could
 * answer none: no rate, so no visit could be closed; no priced service, so no
 * margin; no hours, so no break-even and no online booking. Each was then asked
 * for again, one screen at a time, by a checklist on the dashboard.
 *
 * Then it asked all of them at once, which was better and still wrong: a form
 * of a dozen fields is a form, and every one of those fields had an answer the
 * product could supply. So it supplies them. What is left is what only the
 * owner knows — where the studio is, what shape it is, and whether they work
 * at a table themselves.
 *
 * Everything filled in behind them is a starting point, not a claim: forty per
 * cent, one manicure priced as an example, Monday to Friday. All of it is
 * editable two clicks away, and the first screen after this one shows the
 * numbers those defaults produce — so a wrong default is visible as a wrong
 * figure rather than hidden in a settings page nobody opens.
 */

/** Nothing to subscribe to: a browser's timezone does not change under an open form. */
const subscribeToNothing = () => () => {};

export function WorkspaceSetup({
  locale,
  bookingAvailable,
}: {
  locale: AppLocale;
  /**
   * Whether the public booking surface is switched on for this deployment
   * (`PUBLIC_BOOKING_ENABLED`). Offered only then: a tick promising a page that
   * would answer 404 is worse than no tick.
   */
  bookingAvailable: boolean;
}) {
  const router = useRouter();
  /*
   * The language of this screen, and of everything after it.
   *
   * It used to be decided in silence: `resolveLocale()` read the browser's
   * `Accept-Language` and that became the organization's language until
   * somebody found the picker in Настройки — a screen that requires a
   * workspace, which is the thing being created here.
   *
   * Changing it re-renders this screen rather than only tagging the request: a
   * picker that leaves the form it sits on in the previous language is a
   * promise the reader can watch being broken.
   */
  const [uiLocale, setUiLocale] = useState<AppLocale>(locale);
  const t = getTranslator(uiLocale);

  const [businessType, setBusinessType] = useState<BusinessType>("solo");
  /*
   * Whether the owner takes clients themselves — the question the format used
   * to answer on their behalf.
   *
   * `solo` meant «I work alone» and therefore «I am the master»; `studio` meant
   * nothing, so the woman who owns a studio of three and works at a table
   * herself had to go and find «Это я» on a screen she had no reason to open.
   * Her card carries two facts nothing else supplies: the account it belongs to,
   * which is how her calendar and her visits are hers, and the principal mark,
   * without which the month's profit is understated by the whole cost of her
   * work.
   */
  const [ownerWorks, setOwnerWorks] = useState(true);
  /*
   * Whether clients can book online from the first minute.
   *
   * On by default, because the alternative is what the product did until now:
   * two switches on a screen a new studio has no reason to open, and a public
   * page that answers 404 in the meantime. What makes it safe to default is the
   * confirmation mode registration writes with it — every request waits for the
   * owner (`lib/workspace-provisioning.ts`).
   */
  const [publishBooking, setPublishBooking] = useState(true);

  /*
   * The currency, which is the browser's zone until the owner says otherwise.
   *
   * Read through `useSyncExternalStore` rather than during render, because the
   * server's zone is the host's and not the owner's: the server snapshot is the
   * pilot's currency, the client's is the one its own zone implies, and React
   * swaps them after hydration instead of rendering two different fields and
   * complaining about it.
   */
  const detectedCurrency = useSyncExternalStore(
    subscribeToNothing,
    () => currencyForTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    () => "MDL" as Currency,
  );
  const [chosenCurrency, setChosenCurrency] = useState<Currency | null>(null);
  const currency = chosenCurrency ?? detectedCurrency;

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);

    /*
     * No name is sent at all: the studio was named at sign-up, and the server
     * reads it from the account — latinising it if it was written in another
     * alphabet, and falling back to the address if it was written in one the
     * table does not know.
     */
    const service = catalogueEntry(DEFAULT_SERVICE.key);
    const ownerName = String(data.get("owner_name") ?? "").trim();

    const response = await fetch("/api/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: businessType,
        currency,
        locale: uiLocale,
        address: String(data.get("address") ?? "").trim(),
        // The zone the studio's hours are read in. The browser's own is the
        // only signal there is, and it is right for everybody who is not
        // registering a studio in a country they are not in.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Somebody working alone always works: the format is the answer there,
        // and the tick is only offered to a studio.
        owner_works: businessType === "solo" ? true : ownerWorks,
        // Only a studio asks: a solo workspace's one card is the studio, and
        // «Nails by Irina» in the calendar is the truth rather than a
        // placeholder.
        ...(businessType === "studio" && ownerWorks && ownerName ? { owner_name: ownerName } : {}),
        ...(bookingAvailable ? { publish_booking: publishBooking } : {}),
        commission_basis_points: DEFAULT_COMMISSION_PERCENT * 100,
        ...(service
          ? {
              services: [
                {
                  key: DEFAULT_SERVICE.key,
                  price_minor: DEFAULT_SERVICE.priceMinor,
                  duration_minutes: service.durationMinutes,
                },
              ],
            }
          : {}),
        workweek: {
          weekdays: DEFAULT_WORKWEEK.weekdays,
          start: DEFAULT_WORKWEEK.start,
          end: DEFAULT_WORKWEEK.end,
        },
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const code = payload?.error?.code;
      setError(
        code
          ? getErrorMessage(code, payload.error.message ?? t("workspace.failed"), uiLocale)
          : t("workspace.failed"),
      );
      setPending(false);
      return;
    }

    router.refresh();
  }

  return (
    <main className="auth-shell">
      <section className="auth-card workspace-card">
        <label className="setup-language">
          {t("workspace.language")}
          <select
            value={uiLocale}
            onChange={(event) => setUiLocale(event.target.value as AppLocale)}
          >
            {/*
              Codes, not endonyms. «Русский / Română / English» is the right
              offer in Настройки, where somebody has come specially to change
              the language; here it is one control among four, and RU/RO/EN is
              read without being read.
            */}
            {supportedLocales.map((option) => (
              <option key={option} value={option}>
                {option.toUpperCase()}
              </option>
            ))}
          </select>
        </label>

        <h1>{t("workspace.title")}</h1>

        <form onSubmit={submit}>
          <label>
            {t("workspace.address")}
            {/*
              The one thing on this form with no sensible default. A rota
              belongs to a specialist *at an address*, and the public booking
              page is served from one — so this is asked, and everything the
              studio is called is derived from the account behind it.
            */}
            <input
              name="address"
              required
              maxLength={300}
              placeholder={t("workspace.addressPlaceholder")}
            />
          </label>

          <fieldset>
            <legend>{t("workspace.format")}</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="type"
                value="solo"
                checked={businessType === "solo"}
                onChange={() => setBusinessType("solo")}
              />{" "}
              {t("workspace.solo")}
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="type"
                value="studio"
                checked={businessType === "studio"}
                onChange={() => setBusinessType("studio")}
              />{" "}
              {t("workspace.studio")}
            </label>
          </fieldset>

          {/*
            Asked of a studio only. A workspace registered as solo is one person
            working — the format is the answer — and a tick offering to say
            otherwise would be offering to create a studio with nobody in it.
          */}
          {businessType === "studio" && (
            <fieldset className="checkbox-set">
              <legend>{t("workspace.people")}</legend>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={ownerWorks}
                  onChange={(event) => setOwnerWorks(event.target.checked)}
                />{" "}
                {t("workspace.ownerWorks")}
              </label>
              {ownerWorks && (
                <label>
                  {/*
                    The name on the owner's own card, which a client reads in
                    the list of who is available. Without it the card is named
                    after the studio, and the page offers «Studio Belle»
                    standing beside «Ana» and «Maria».
                  */}
                  {t("workspace.ownerName")}
                  <input name="owner_name" maxLength={200} />
                </label>
              )}
            </fieldset>
          )}

          {bookingAvailable && (
            <fieldset className="checkbox-set">
              <legend>{t("workspace.booking")}</legend>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={publishBooking}
                  onChange={(event) => setPublishBooking(event.target.checked)}
                />{" "}
                {t("workspace.publishBooking")}
              </label>
              {/*
                One line, and it is the one that makes the default safe to
                accept without thinking: the page goes up, but nothing on it
                becomes an appointment until the owner says so.
              */}
              <span className="field-hint">{t("workspace.publishBookingHint")}</span>
            </fieldset>
          )}

          <label>
            {t("workspace.currency")}
            {/*
              Codes only, and every code the books can be kept in — the list is
              `domain/money.ts`, so a currency added there is offered here
              without this screen being edited. Their names are spelled out in
              Настройки, where there is room for a line of prose.
            */}
            <select
              name="currency"
              value={currency}
              onChange={(event) => setChosenCurrency(event.target.value as Currency)}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="primary-button" disabled={pending}>
            {pending ? t("workspace.creating") : t("workspace.continue")}
          </button>
        </form>
      </section>
      {/*
        «Удалить аккаунт» is not offered here any more, and nothing replaced it.
        Worth knowing what that closes: an account with no organization has no
        Настройки to reach — that page requires a workspace — so this screen was
        the only exit from the product that was not «create a studio». Somebody
        who has just erased their studio now cannot delete the account either,
        and cannot register afresh on the same address, because that address is
        still held by the account they are inside. `DELETE /api/v1/account` is
        untouched and still refuses an owner with a live studio, so the way back
        is to call it directly or to put this control back.
      */}
    </main>
  );
}
