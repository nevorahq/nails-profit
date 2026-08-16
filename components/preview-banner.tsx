"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { MemberRole } from "@/domain/rbac";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

export type PreviewBannerContext = Readonly<{
  targetName: string;
  targetEmail: string;
  targetRole: MemberRole;
  actorEmail: string;
}>;

/**
 * The standing reminder that this is not the owner's own screen.
 *
 * Preview swaps every other signal at once — the navigation, the account chip,
 * the figures — so that what the owner sees is what their colleague sees. That
 * is the point, and it is also the risk: with nothing left saying otherwise, an
 * owner can forget whose interface they are reading and conclude their own
 * numbers are wrong. So the banner is not dismissible, sits above everything at
 * every width, and names both people — the one being watched and the one
 * watching.
 *
 * It also carries the way out, because the way out must be somewhere the owner
 * is already looking. Leaving is a cookie deletion and a refresh: no sign-in,
 * no password, and the owner's own session was never touched to begin with.
 */
export function PreviewBanner({
  preview,
  stale,
  locale,
}: {
  preview: PreviewBannerContext | null;
  /**
   * A selection the server refused — the colleague was removed, or the cookie
   * outlived the account that set it. Section 28 of the brief asks for a
   * fallback to owner mode rather than an error, and the owner is already in
   * owner mode by the time this renders; all that is left is to clear the dead
   * cookie so the next request is not read-only for no reason.
   */
  stale: boolean;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!stale || preview) return;
    let cancelled = false;

    void fetch("/api/v1/preview", { method: "DELETE" }).then(() => {
      if (!cancelled) router.refresh();
    });

    return () => {
      cancelled = true;
    };
  }, [stale, preview, router]);

  if (!preview) return null;

  async function exit() {
    setPending(true);
    const response = await fetch("/api/v1/preview", { method: "DELETE" });
    if (!response.ok) {
      setPending(false);
      return;
    }
    // Back to the dashboard rather than to whichever page this was: half the
    // sections a master can open are ones the owner arrived from somewhere
    // else entirely, and landing on a page that no longer means the same thing
    // is a worse welcome back than the home screen.
    router.push("/app");
    router.refresh();
  }

  return (
    <div className="preview-banner" role="status">
      <span className="preview-banner-text">
        <strong>{t("preview.viewingAs", { name: preview.targetName || preview.targetEmail })}</strong>
        <span className="preview-banner-detail">
          {t(`roles.${preview.targetRole}` as MessageKey)} · {t("preview.readOnly")} ·{" "}
          {t("preview.signedInAs", { email: preview.actorEmail })}
        </span>
      </span>
      <button className="preview-banner-exit" type="button" onClick={exit} disabled={pending}>
        {pending ? t("preview.exiting") : t("preview.exit")}
      </button>
    </div>
  );
}
