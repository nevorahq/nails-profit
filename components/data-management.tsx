"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

export function DataManagement({
  locale,
  organizationName,
  canExport,
  canDelete,
}: {
  locale: AppLocale;
  organizationName: string;
  canExport: boolean;
  canDelete: boolean;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function removeOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const response = await fetch("/api/v1/organizations/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation_name: confirmation }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? t("settings.deleteFailed"));
      setPending(false);
      return;
    }

    await authClient.signOut();
    router.replace("/");
    router.refresh();
  }

  return (
    <section className="panel" aria-labelledby="data-management-title">
      <h2 id="data-management-title">{t("settings.dataTitle")}</h2>
      <p className="muted">{t("settings.dataHint")}</p>

      {canExport ? (
        <a className="secondary-button" href="/api/v1/organizations/export" download>
          {t("settings.export")}
        </a>
      ) : (
        <p className="warning-banner">{t("settings.ownerOnly")}</p>
      )}

      {canDelete && (
        <form className="danger-zone" onSubmit={removeOrganization}>
          <h3>{t("settings.deleteTitle")}</h3>
          <p id="delete-organization-hint" className="muted">
            {t("settings.deleteHint", { name: organizationName })}
          </p>
          <label>
            {t("settings.confirmName")}
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-describedby="delete-organization-hint"
              autoComplete="off"
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="danger-button"
            type="submit"
            disabled={pending || confirmation !== organizationName}
          >
            {pending ? t("common.saving") : t("settings.deleteAction")}
          </button>
        </form>
      )}
    </section>
  );
}
