"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { currencies } from "@/domain/money";
import { slugify } from "@/domain/slug";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * Naming the studio: station two of the setup, and nothing else.
 *
 * No greeting by name and no notice about a studio that was deleted. Both were
 * tried and both were wrong here: «Добро пожаловать, N» reads as the end of
 * something on a screen that is the middle of it, and an explanation of what
 * happened to the previous studio is news to nobody — the person reading it is
 * the person who deleted it, one screen ago. What the screen owes them is the
 * path and the form.
 */
export function WorkspaceSetup({ locale }: { locale: AppLocale }) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const response = await fetch("/api/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        type: data.get("type"),
        currency: data.get("currency"),
        locale,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const code = payload?.error?.code;
      setError(
        code
          ? getErrorMessage(code, payload.error.message ?? t("workspace.failed"), locale)
          : t("workspace.failed"),
      );
      setPending(false);
      return;
    }

    /*
     * The studio's first address, created with the studio rather than found
     * missing later.
     *
     * Without one the rota cannot be written at all — a schedule belongs to a
     * specialist *at an address* — so «Рабочие часы в графике», the last step
     * of the month's checklist, used to send an owner to a screen that first
     * demanded something nobody had told them about. The one fact only they
     * know is asked here; the rest is derived: the address is named after the
     * studio, its link is the transliteration of that name, and the timezone is
     * the browser's own.
     *
     * A failure here is not fatal and does not hold the workspace hostage: the
     * organization exists, and `/app/booking` can still add an address by hand.
     * Blocking would leave somebody stuck on a form whose resubmission is
     * refused as MEMBERSHIP_EXISTS.
     */
    await fetch("/api/v1/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        slug: slugify(name),
        address: String(data.get("address") ?? "").trim(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    }).catch(() => undefined);

    router.refresh();
  }

  return (
    <main className="auth-shell">
      <section className="auth-card workspace-card">
        <h1>{t("workspace.title")}</h1>
        {/*
          Station two of five. This screen used to arrive with no sense of where
          it sat: an account had just been created, and here was another form,
          equally unexplained. The path says the account is behind them and what
          the studio is for.
        */}
        <form onSubmit={submit}>
          <label>
            {t("workspace.name")}
            {/*
              Latin only, refused by the field rather than by the server.
              Transliteration would cope — `domain/slug.ts` turns «Студия» into a
              usable `/book/studiya` — so this is a naming decision, not a
              technical limit, and the rule is stated under the field instead of
              appearing as a mysterious refusal on submit.
            */}
            <input
              name="name"
              required
              minLength={2}
              pattern={String.raw`[A-Za-zĂÂÎȘȚăâîșț0-9 &'’.\-]{2,}`}
              title={t("workspace.nameLatin")}
              placeholder={t("workspace.namePlaceholder")}
            />
            <span className="field-hint">{t("workspace.nameLatin")}</span>
          </label>
          <label>
            {t("workspace.address")}
            <input
              name="address"
              required
              maxLength={300}
              placeholder={t("workspace.addressPlaceholder")}
            />
          </label>
          <fieldset>
            <legend>{t("workspace.format")}</legend>
            <label className="radio-row"><input type="radio" name="type" value="solo" defaultChecked /> {t("workspace.solo")}</label>
            <label className="radio-row"><input type="radio" name="type" value="studio" /> {t("workspace.studio")}</label>
            {/*
              No prose under the choice any more. What it explained was true —
              the format moves wording, «оплата вашего труда» against «оплата
              труда мастеров», and not one figure — but the clause that made it
              safe to answer quickly, «переключается потом в настройках», had
              already stopped being: settings does not offer the control. The
              silence costs nothing, because nothing now depends on this answer
              being right on the first minute — `lib/solo-mode.ts` corrects it
              the day a second master appears.
            */}
          </fieldset>
          <label>
            {t("workspace.currency")}
            {/*
              Codes only, and every code the books can be kept in — the list is
              `domain/money.ts`, so a currency added there is offered here
              without this screen being edited. Their names are spelled out in
              Настройки, where there is room for a line of prose; this is the
              first minute of an account and the picker is one of four fields.
            */}
            <select name="currency" defaultValue="MDL">
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-button" disabled={pending}>{pending ? t("workspace.creating") : t("workspace.continue")}</button>
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
