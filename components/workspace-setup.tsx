"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { currencies } from "@/domain/money";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { AccountDeletion } from "@/components/account-deletion";
import { getTranslator } from "@/i18n/t";

/**
 * Naming the studio: station two of the setup, and nothing else.
 *
 * No greeting by name and no notice about a studio that was deleted. Both were
 * tried and both were wrong here: «Добро пожаловать, N» reads as the end of
 * something on a screen that is the middle of it, and an explanation of what
 * happened to the previous studio is news to nobody — the person reading it is
 * the person who deleted it, one screen ago. What the screen owes them is the
 * path, the form, and a way out.
 */
export function WorkspaceSetup({
  email,
  locale,
}: {
  /** The account's own address, for the deletion form's confirmation. */
  email: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
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
              pattern="[A-Za-zĂÂÎȘȚăâîșț0-9 &'’.-]{2,}"
              title={t("workspace.nameLatin")}
              placeholder={t("workspace.namePlaceholder")}
            />
            <span className="field-hint">{t("workspace.nameLatin")}</span>
          </label>
          <fieldset>
            <legend>{t("workspace.format")}</legend>
            <label className="radio-row"><input type="radio" name="type" value="solo" defaultChecked /> {t("workspace.solo")}</label>
            <label className="radio-row"><input type="radio" name="type" value="studio" /> {t("workspace.studio")}</label>
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
        The only way out of this screen that is not «create a studio». An
        account with no organization has no Настройки to reach — the whole
        settings page requires a workspace — so without this, somebody who has
        just erased their studio cannot delete their account, and cannot
        register again either: the address is still taken by the account they
        are locked inside.
      */}
      <AccountDeletion locale={locale} email={email} variant="link" />
    </main>
  );
}
