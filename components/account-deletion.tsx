"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

/**
 * Leaving for good, which the product could not do until now.
 *
 * Deleting a studio and deleting an account are two different acts and this is
 * the second one. It appears in both places somebody might want it: in Настройки
 * for anybody who is not the owner of a live studio, and on the workspace form —
 * where an owner who has just erased their studio lands, and where there is no
 * Настройки to go to, because there is no longer an organization to have
 * settings for.
 *
 * The address is retyped, like the studio's name is. The mismatch is answered
 * here rather than by the server's own wording: `CONFIRMATION_MISMATCH` is
 * shared with the organization form, where it says «Название не совпадает».
 */
export function AccountDeletion({
  locale,
  email,
  variant = "button",
}: {
  locale: AppLocale;
  email: string;
  /**
   * How loudly to offer it. On the settings screen this is one action among
   * others and looks like one; on the workspace form it is a footnote — that
   * screen exists to start a studio, and leaving the product should not sit on
   * it as a second, competing button.
   */
  variant?: "button" | "link";
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const response = await fetch("/api/v1/account/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation_email: confirmation }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code;
      setError(
        code === "CONFIRMATION_MISMATCH"
          ? t("settings.accountMismatch")
          : code
            ? getErrorMessage(code, body.error.message ?? t("settings.accountFailed"), locale)
            : t("settings.accountFailed"),
      );
      setPending(false);
      return;
    }

    /*
     * The session died with the account — `session` cascades from `user` — so
     * this only clears the cookie the browser is still carrying. Without it the
     * next request travels with a token nothing answers to.
     */
    await authClient.signOut().catch(() => undefined);
    router.replace("/");
    router.refresh();
  }

  /*
    Closed, this is one button and nothing else — no panel around it and no
    heading above it repeating its own words, which is what «Delete account /
    Delete account» was. What deletion costs, and what has to happen first,
    belongs to the moment the decision is being made rather than to every visit
    to the screen, so the heading and the consequences arrive with the field.
  */
  if (!open) {
    return (
      <p className="account-deletion-trigger">
        <button
          className={variant === "link" ? "text-link-button" : "secondary-button"}
          type="button"
          onClick={() => setOpen(true)}
        >
          {t("settings.accountAction")}
        </button>
      </p>
    );
  }

  return (
    <section className="panel account-deletion" aria-labelledby="account-deletion-title">
      <h2 id="account-deletion-title">{t("settings.accountTitle")}</h2>
      <p className="muted">{t("settings.accountHint")}</p>

      <form onSubmit={submit}>
        <label>
          {t("settings.confirmEmail")}
          <input
            name="confirmation_email"
            type="email"
            autoComplete="off"
            placeholder={email}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          <button className="danger-button" disabled={pending || confirmation.trim().length === 0}>
            {t("settings.accountAction")}
          </button>
          <button className="secondary-button" type="button" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}
