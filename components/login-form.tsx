"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";
import { authRefusal } from "@/domain/auth-refusal";
import { invitationTokenFromNext } from "@/domain/invitation-link";

export function LoginForm({
  initialMode = "signin",
  locale,
  next,
  activeEmail = null,
  invitation = null,
}: {
  initialMode?: "signin" | "signup";
  locale: AppLocale;
  next?: string;
  /** Who is signed in in this browser already, and about to be replaced. */
  activeEmail?: string | null;
  /**
   * The live invitation this form was reached from, when it was.
   *
   * One object rather than an address beside a studio name, because the two
   * are one fact and must not be able to disagree: its presence is what makes
   * this registration a joining rather than a founding, and everything that
   * differs between the two reads it — the address, fixed to the one the link
   * was mailed to because no other leads anywhere, and the name, which belongs
   * to a person here and to a studio otherwise.
   */
  invitation?: { email: string; organizationName: string } | null;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const redirectTo = next ?? "/app";
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /*
   * The address a failed sign-in was tried with, kept so switching to
   * registration — «Нет аккаунта? Создать», at the bottom — arrives with the
   * address already filled in rather than empty.
   */
  const [refusedEmail, setRefusedEmail] = useState<string | null>(null);

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
      /*
       * A refused attempt is answered in the interface's own language and with
       * somewhere to go. Which of the three answers it gets — and why the
       * interface refuses to say what was wrong — is in `domain/auth-refusal.ts`.
       *
       * Carrying the address over to registration belongs to `no_match` alone:
       * it is the only refusal where creating an account is the plausible next
       * step, and a rate-limited attempt says nothing about whether one exists.
       */
      const refusal = authRefusal(mode, result.error.status);
      setError(
        refusal === "rate_limited"
          ? t("auth.tooManyAttempts")
          : refusal === "no_match"
            ? t("auth.signInNoMatch")
            : (result.error.message ?? t("auth.signInFailed")),
      );
      setRefusedEmail(refusal === "no_match" ? email : null);
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
     * only go one way. The address makes it safe to skip: `invitation.email`
     * is the invitation's own, fixed and unchangeable in this form, so an
     * account created from this link always matches the invitation it came
     * from.
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
      {activeEmail && (
        <div className="warning-banner">{t("auth.activeSession", { email: activeEmail })}</div>
      )}
      <form onSubmit={submit}>
        {mode === "signup" &&
          (invitation ? (
            <label>
              {t("auth.personName")}
              {/*
                A person, because this one is joining a studio that already has
                a name — the card she pressed «Создать аккаунт» on says which,
                and the line under the address below says it again. Asked for
                «Название студии» she had nothing to answer, and no way to know
                that what she typed would become her own name: `users.name` is
                what the studio then reads on «Мастера» and what her specialist
                card is created with.

                No Latin rule here either. That one is about the name a client
                reads on a booking link (`domain/organization-name.ts`), and
                this field does not write one — it refused «Ирина» to a woman
                whose name is Ирина, in the browser's language, over a rule that
                was never about her.
              */}
              <input
                name="name"
                required
                minLength={2}
                maxLength={100}
                autoComplete="name"
                placeholder={t("auth.personNamePlaceholder")}
              />
              <span className="field-hint">{t("auth.personNameHint")}</span>
            </label>
          ) : (
            <label>
              {t("auth.studioName")}
              {/*
                The studio, not the person. It used to ask «Ваше имя», and the
                account's name was then quietly turned into the studio's — which
                is the name a client reads on a booking link, so the owner was
                choosing it without being told they were. Nothing else in the
                product ever showed the person's own name.

                Latin only, refused by the field rather than by the server.
                Transliteration copes — `domain/organization-name.ts` turns
                «Студия» into «Studiya» — so this is a naming decision, not a
                technical limit, and it is stated under the field instead of
                arriving as a mysterious refusal one screen later.
              */}
              <input
                name="name"
                required
                minLength={2}
                maxLength={100}
                pattern={String.raw`[A-Za-zĂÂÎȘȚăâîșț0-9 &'’.\-]{2,}`}
                title={t("auth.studioNameLatin")}
                placeholder={t("auth.studioNamePlaceholder")}
              />
              <span className="field-hint">{t("auth.studioNameLatin")}</span>
            </label>
          ))}
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
            key={refusedEmail ?? "email"}
            defaultValue={invitation?.email ?? refusedEmail ?? undefined}
            readOnly={invitation !== null}
          />
        </label>
        {invitation && (
          <p className="muted">
            {t("auth.invitedEmailHint", { org: invitation.organizationName })}
          </p>
        )}
        <label>
          {t("auth.password")}
          <input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={10} />
          {/*
            The rule the field enforces, on the screen that enforces it. Ten
            characters is not a guessable number, and the only way anybody
            learned it was by being refused — by the browser, in the browser's
            language, which on a Romanian pilot's laptop is not the one the
            rest of this card is in. Only while registering: somebody signing
            in already has a password and does not need to be told what it must
            look like.
          */}
          {mode === "signup" && <span className="field-hint">{t("auth.passwordHint")}</span>}
        </label>
        {mode === "signup" && (
          <div className="consent-field">
            <input id="legalAccepted" name="legalAccepted" type="checkbox" required />
            {/*
              One line, including on a phone, where the full sentence — «Я
              принимаю условия использования и ознакомился(-ась) с уведомлением
              о конфиденциальности» — ran to three and pushed the button below
              the fold. The documents keep their full names two rows down, in
              the footer of this same card, and on the pages themselves; the
              consent says what is being consented to and links to both.
            */}
            <label htmlFor="legalAccepted">
              {t("auth.legalPrefix")} <Link href="/terms">{t("auth.legalTermsShort")}</Link>{" "}
              {t("auth.legalAnd")} <Link href="/privacy">{t("auth.legalPrivacyShort")}</Link>
            </label>
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
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
