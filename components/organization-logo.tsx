"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

import { BrandMark } from "@/components/icons";
import { organizationLogoUrl } from "@/domain/avatar-image";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { squareImage } from "@/lib/square-image";

/**
 * The studio's mark, and the two controls that set it.
 *
 * The flower is the preview until there is a picture, because the flower is
 * what the topbar draws until there is one — the same `BrandMark` component, so
 * this block shows the present state rather than an illustration of it. Removing
 * a logo brings it back here and there at the same moment.
 *
 * The picture is squared and shrunk in the browser before it is sent; see
 * `lib/square-image.ts` for why that happens here rather than at the endpoint.
 */
export function OrganizationLogo({
  version,
  canEdit,
  locale,
}: {
  /** The stored mark's version, or null when the studio has none. Also cache-busts. */
  version: number | null;
  canEdit: boolean;
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // The input is reset immediately, so choosing the same file twice in a row
    // still fires a change — the second attempt after a failure is the common
    // case here.
    event.target.value = "";
    if (!file) return;

    setPending(true);
    setError(null);

    const squared = await squareImage(file, "logo").catch(() => null);
    if (!squared) {
      setError(t("settings.logoNotAnImage"));
      setPending(false);
      return;
    }

    const body = new FormData();
    body.set("file", squared);
    const response = await fetch("/api/v1/organizations/logo", { method: "POST", body });
    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("common.saveFailed"));
      return;
    }
    // The topbar is rendered by the layout above this page, so the server has
    // to draw it again: a state in the browser would have changed the preview
    // here and left the flower in the corner of the screen.
    router.refresh();
  }

  async function remove() {
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/organizations/logo", { method: "DELETE" });
    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("common.saveFailed"));
      return;
    }
    router.refresh();
  }

  const pickLabel = version === null ? t("settings.logoAdd") : t("settings.logoReplace");

  return (
    <section className="panel">
      <h2>{t("settings.logoTitle")}</h2>
      <p className="muted">{t("settings.logoHint")}</p>

      <div className="studio-logo">
        <span className="studio-logo-preview" aria-hidden="true">
          {version === null ? (
            <BrandMark />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a studio's own picture, not a build-time asset.
            <img src={organizationLogoUrl(version) as string} alt="" />
          )}
        </span>

        <div className="studio-logo-actions">
          {canEdit ? (
            <>
              {/*
                A label rather than a button that clicks a hidden input: the
                file picker is the input's own, so there is no second element
                to keep in step with it and nothing to do when JavaScript has
                not arrived yet. `sr-only` rather than `hidden` keeps the input
                in the focus order — it is what a keyboard lands on.
              */}
              <label className="secondary-button">
                {pickLabel}
                <input
                  className="sr-only"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={pending}
                  onChange={upload}
                />
              </label>
              {version !== null && (
                <button className="inline-action danger" type="button" disabled={pending} onClick={remove}>
                  {t("settings.logoRemove")}
                </button>
              )}
            </>
          ) : (
            <span className="muted">{t("settings.ownerOnly")}</span>
          )}
          {pending && <span className="muted">{t("common.saving")}</span>}
          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
