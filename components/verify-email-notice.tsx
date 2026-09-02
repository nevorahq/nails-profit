"use client";

import { useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

/**
 * One strip: this address has not been confirmed, and a way to send the letter
 * again.
 *
 * Deliberately not a gate. The address matters for one thing — recovering the
 * account when the password is lost — and that is a future problem, while the
 * studio in front of the owner is a present one. So nothing here refuses to let
 * them work; it says the thing once, in a line, until it is done.
 *
 * What it must not say is that recovery needs the confirmation. It does not:
 * `sendResetPassword` mails whatever address is on file, confirmed or not, and
 * nothing in the reset path reads `emailVerified` at all. What an unconfirmed
 * address hides is a typo — and a typo is what turns "I forgot my password"
 * into a studio shut out of its own books with no way back.
 */
export function VerifyEmailNotice({ locale, email }: { locale: AppLocale; email: string }) {
  const t = getTranslator(locale);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function resend() {
    setState("sending");
    const result = await authClient
      .sendVerificationEmail({ email, callbackURL: "/app" })
      .catch(() => ({ error: true }) as const);
    setState("error" in result && result.error ? "failed" : "sent");
  }

  return (
    <div className="verify-notice" role="status">
      <span>{t("auth.verifyPending")}</span>
      {state === "sent" ? (
        <span className="verify-notice-done">{t("auth.verifySent")}</span>
      ) : (
        <button
          className="text-link-button"
          type="button"
          onClick={resend}
          disabled={state === "sending"}
        >
          {state === "failed" ? t("auth.verifyRetry") : t("auth.verifyResend")}
        </button>
      )}
    </div>
  );
}
