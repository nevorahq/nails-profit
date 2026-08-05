"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

export function ResetPasswordForm({
  token,
  linkError,
  locale,
}: {
  token?: string;
  linkError?: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The callback redirects here with ?error=INVALID_TOKEN when the link is
  // expired or already used, so there is no point rendering the form at all.
  if (!token || linkError) {
    return (
      <section className="auth-card">
        <Link className="brand" href="/">
          Nail Profit OS
        </Link>
        <h1>{t("auth.linkInvalid")}</h1>
        <p>{t("auth.linkInvalidBody")}</p>
        <Link className="primary-button" href="/forgot-password">
          {t("auth.requestNewLink")}
        </Link>
      </section>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));

    if (password !== String(data.get("passwordConfirmation"))) {
      setError(t("auth.passwordsDiffer"));
      setPending(false);
      return;
    }

    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) {
      setError(result.error.message ?? t("auth.passwordChangeFailed"));
      setPending(false);
      return;
    }

    router.push("/login");
    router.refresh();
  }

  return (
    <section className="auth-card">
      <Link className="brand" href="/">
        Nail Profit OS
      </Link>
      <h1>{t("auth.newPassword")}</h1>
      <p>{t("auth.newPasswordHint")}</p>
      <form onSubmit={submit}>
        <label>
          {t("auth.newPassword")}
          <input name="password" type="password" autoComplete="new-password" required minLength={10} />
        </label>
        <label>
          {t("auth.repeatPassword")}
          <input
            name="passwordConfirmation"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("auth.savePassword")}
        </button>
      </form>
    </section>
  );
}
