"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

export function WorkspaceSetup({ name, locale }: { name: string; locale: AppLocale }) {
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
        <span className="eyebrow">{t("workspace.welcome", { name })}</span>
        <h1>{t("workspace.title")}</h1>
        <form onSubmit={submit}>
          <label>
            {t("workspace.name")}
            <input name="name" required minLength={2} placeholder={t("workspace.namePlaceholder")} />
          </label>
          <fieldset>
            <legend>{t("workspace.format")}</legend>
            <label className="radio-row"><input type="radio" name="type" value="solo" defaultChecked /> {t("workspace.solo")}</label>
            <label className="radio-row"><input type="radio" name="type" value="studio" /> {t("workspace.studio")}</label>
          </fieldset>
          <label>
            {t("workspace.currency")}
            <select name="currency" defaultValue="MDL"><option value="MDL">MDL</option><option value="EUR">EUR</option></select>
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" disabled={pending}>{pending ? t("workspace.creating") : t("workspace.continue")}</button>
        </form>
      </section>
    </main>
  );
}
