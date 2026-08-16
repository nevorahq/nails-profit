"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

/**
 * The two controls on `/join` that do something, split out of the page so the
 * page itself can stay a server component and resolve the invitation before it
 * renders.
 *
 * Everything else on that screen — which studio, which address, whether the
 * link is still live — is decided in `app/join/page.tsx`. What is left here is
 * the click.
 */
export function JoinAccept({ token, locale }: { token: string; locale: AppLocale }) {
  const t = getTranslator(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);

    const response = await fetch("/api/v1/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (response.ok) {
      setDone(true);
      setPending(false);
      // The shell reads the membership on the server, and until it is refreshed
      // the navigation still belongs to someone with no organization.
      router.refresh();
      return;
    }

    /*
     * The page already decided that this invitation was live and addressed to
     * this account, so a failure here is a race rather than the normal path:
     * the owner revoked the link, or it expired, in the seconds the screen was
     * open. Refreshing re-runs that decision on the server and lands on the
     * screen that explains it, which is better than a message under a button
     * that would still look pressable.
     */
    const body = await response.json().catch(() => null);
    const code = body?.error?.code;
    setPending(false);
    if (code === "UNAUTHENTICATED" || code === "INVITATION_NOT_PENDING" || code === "INVITATION_EXPIRED") {
      router.refresh();
      return;
    }
    setError(getErrorMessage(code ?? "", body?.error?.message ?? t("join.failed"), locale));
  }

  if (done) {
    return (
      <>
        <p style={{ fontWeight: 700, marginBottom: "16rem" }}>{t("join.success")}</p>
        <button
          className="primary-button"
          type="button"
          style={{ width: "100%" }}
          onClick={() => {
            router.push("/app");
            router.refresh();
          }}
        >
          {t("join.goToApp")}
        </button>
      </>
    );
  }

  return (
    <>
      {error && (
        <div className="form-error" role="alert" style={{ marginBottom: "16rem" }}>
          {error}
        </div>
      )}
      <button
        className="primary-button"
        type="button"
        onClick={accept}
        disabled={pending}
        style={{ width: "100%" }}
      >
        {pending ? t("join.accepting") : t("join.accept")}
      </button>
    </>
  );
}

/**
 * Signing out before signing in as someone else.
 *
 * The old screen linked straight to `/login`, which replaces the session cookie
 * on success but leaves the wrong account signed in for anyone who stops
 * halfway — on the invitation screen, with the same wrong account, and no way
 * to tell that nothing changed. Ending the session first makes the state after
 * the click unambiguous.
 */
export function JoinSwitchAccount({ token, locale }: { token: string; locale: AppLocale }) {
  const t = getTranslator(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function switchAccount() {
    setPending(true);
    await authClient.signOut();
    const next = encodeURIComponent(`/join?token=${encodeURIComponent(token)}`);
    router.push(`/login?next=${next}`);
    router.refresh();
  }

  return (
    <button
      className="primary-button"
      type="button"
      onClick={switchAccount}
      disabled={pending}
      style={{ width: "100%" }}
    >
      {pending ? t("join.switching") : t("join.switchAccount")}
    </button>
  );
}
