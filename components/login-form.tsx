"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

export function LoginForm({
  initialMode = "signin",
  locale,
  next,
}: {
  initialMode?: "signin" | "signup";
  locale: AppLocale;
  next?: string;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const redirectTo = next ?? "/app";
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email"));
    const password = String(data.get("password"));

    const result =
      mode === "signup"
        ? await authClient.signUp.email({
            email,
            password,
            name: String(data.get("name")),
            legalAccepted: data.get("legalAccepted") === "on",
            callbackURL: redirectTo,
          })
        : await authClient.signIn.email({ email, password, callbackURL: redirectTo });

    if (result.error) {
      setError(result.error.message ?? t("auth.signInFailed"));
      setPending(false);
      return;
    }
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <section className="auth-card">
      <Link className="brand" href="/">
        Nail Profit OS
      </Link>
      <h1>{mode === "signup" ? t("auth.signUpTitle") : t("auth.welcomeBack")}</h1>
      <p>{t("auth.subtitle")}</p>
      <form onSubmit={submit}>
        {mode === "signup" && (
          <label>
            {t("auth.name")}
            <input name="name" autoComplete="name" required minLength={2} />
          </label>
        )}
        <label>
          {t("auth.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          {t("auth.password")}
          <input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={10} />
        </label>
        {mode === "signup" && (
          <div className="consent-field">
            <input id="legalAccepted" name="legalAccepted" type="checkbox" required />
            <label htmlFor="legalAccepted">
              {t("auth.legalPrefix")} <Link href="/terms">{t("legal.termsLink")}</Link>{" "}
              {t("auth.legalAnd")} <Link href="/privacy">{t("legal.privacyLink")}</Link>.
            </label>
          </div>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("auth.wait") : mode === "signup" ? t("auth.signUp") : t("auth.signIn")}
        </button>
      </form>
      <button className="switch-button" type="button" onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>
        {mode === "signup" ? t("auth.haveAccount") : t("auth.noAccount")}
      </button>
      {mode === "signin" && (
        <Link className="switch-button" href="/forgot-password">
          {t("auth.forgot")}
        </Link>
      )}
      <footer className="legal-footer">
        <Link href="/privacy">{t("legal.privacyLink")}</Link>
        <Link href="/terms">{t("legal.termsLink")}</Link>
      </footer>
    </section>
  );
}
