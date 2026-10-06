"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { useTranslator } from "@/components/lexicon-provider";
import { authClient } from "@/lib/auth-client";

/** Erasing the studio: the name is retyped, and the account survives it. */
export function StudioDeletion({
  locale,
  organizationName,
}: {
  locale: AppLocale;
  organizationName: string;
}) {
  const t = useTranslator(locale);
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
      <form className="danger-zone" onSubmit={removeOrganization} aria-labelledby="studio-deletion-title">
        <h3 id="studio-deletion-title">{t("settings.deleteTitle")}</h3>
        <p id="delete-organization-hint" className="muted">
          {t("settings.deleteHint", { name: organizationName })}
        </p>
        {/*
          What this action does not do, said before it is taken rather than
          discovered afterwards: the account survives, the address stays
          registered to it, and the next sign-in lands on «создайте студию».
          Somebody who meant to leave the product entirely wants the action
          below this one instead.
        */}
        <p className="muted">{t("settings.deleteKeepsAccount")}</p>
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
  );
}
