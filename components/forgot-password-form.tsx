"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm({ locale }: { locale: AppLocale }) {
  const t = getTranslator(locale);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const data = new FormData(event.currentTarget);

    await authClient.requestPasswordReset({
      email: String(data.get("email")),
      redirectTo: "/reset-password",
    });

    // Always the same outcome, error or not. Telling the user "no such account"
    // would turn this form into a way of checking who has one.
    setSent(true);
    setPending(false);
  }

  if (sent) {
    return (
      <section className="auth-card">
        <Link className="brand" href="/">
          Nail Profit OS
        </Link>
        <h1>{t("auth.checkMail")}</h1>
<p>{t("auth.checkMailBody")}</p>
        <Link className="switch-button" href="/login">
          {t("auth.backToLogin")}
        </Link>
      </section>
    );
  }

  return (
    <section className="auth-card">
      <Link className="brand" href="/">
        Nail Profit OS
      </Link>
      <h1>{t("auth.recoverTitle")}</h1>
      <p>{t("auth.recoverBody")}</p>
      <form onSubmit={submit}>
        <label>
          {t("auth.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("auth.sending") : t("auth.sendLink")}
        </button>
      </form>
      <Link className="switch-button" href="/login">
        {t("auth.rememberedIt")}
      </Link>
    </section>
  );
}
