"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";
import { invitationTokenFromNext } from "@/domain/invitation-link";

export function LoginForm({
  initialMode = "signin",
  locale,
  next,
  activeEmail = null,
  presetEmail = null,
  inviteOrganization = null,
}: {
  initialMode?: "signin" | "signup";
  locale: AppLocale;
  next?: string;
  /** Who is signed in in this browser already, and about to be replaced. */
  activeEmail?: string | null;
  /**
   * The address a live invitation was issued for. Present only when this form
   * was reached from one, and then it is the only address that leads anywhere:
   * the account has to match it for the invitation to be acceptable.
   */
  presetEmail?: string | null;
  /** The inviting studio, so the fixed address is explained rather than imposed. */
  inviteOrganization?: string | null;
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

    /*
     * An invitation the account was just made for is accepted here rather than
     * on the screen it came from.
     *
     * That screen would offer one button, "принять приглашение", to a person
     * who has already pressed «Создать аккаунт» under a card naming the studio
     * and the role — consent given twice, the second time to something that can
     * only go one way. The address makes it safe to skip: `presetEmail` is the
     * invitation's own, fixed and unchangeable in this form, so an account
     * created from this link always matches the invitation it came from.
     *
     * A POST, not a page visit. Joining a studio is a mutation, and `/join` is
     * a GET that a prefetch or a mail scanner can make on its own.
     */
    const token = invitationTokenFromNext(next);
    if (token) {
      const joined = await fetch("/api/v1/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });

      // Anything else — a revoked link, a race with another tab, an address
      // that does not match after all — is left to `/join`, which resolves the
      // invitation on the server and says which of those it was. Landing on
      // `/app` with no organization would explain nothing.
      router.push(joined.ok ? "/app" : redirectTo);
      router.refresh();
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
      {activeEmail && (
        <div className="warning-banner">{t("auth.activeSession", { email: activeEmail })}</div>
      )}
      <form onSubmit={submit}>
        {mode === "signup" && (
          <label>
            {t("auth.name")}
            <input name="name" autoComplete="name" required minLength={2} />
          </label>
        )}
        <label>
          {t("auth.email")}
          {/*
           * `readOnly` rather than `disabled`: a disabled field is left out of
           * the submitted form, which would send an empty address. It is a
           * convenience either way — the server compares the account's address
           * against the invitation again before anyone joins anything.
           */}
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={presetEmail ?? undefined}
            readOnly={presetEmail !== null}
          />
        </label>
        {presetEmail !== null && inviteOrganization !== null && (
          <p className="muted">{t("auth.invitedEmailHint", { org: inviteOrganization })}</p>
        )}
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
