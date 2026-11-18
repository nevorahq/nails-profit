"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { MAX_PHOTOS_PER_VISIT } from "@/domain/visit-photos";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { encodeWorkPhoto } from "@/lib/work-photo-image";

export type VisitPhotoItem = Readonly<{
  id: string;
  url: string;
  width: number;
  height: number;
  /** Shown on the studio's public booking page. */
  published: boolean;
}>;

/**
 * Photos of the work, on the visit's card.
 *
 * The add tile is a label around a file input, like the master's photo: the
 * picker is the input's own, and on a phone `accept="image/*"` offers the
 * camera first — the photo is usually taken there and then, with the client's
 * hands still on the table. The picture is shrunk in the browser before it is
 * sent (`lib/work-photo-image.ts`).
 */
export function VisitPhotos({
  visitId,
  photos,
  canWrite,
  locale,
}: {
  visitId: string;
  photos: readonly VisitPhotoItem[];
  canWrite: boolean;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The photo whose publication is being confirmed, and whether the client's consent is ticked. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);

  async function failure(response: Response) {
    const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    setError(
      body?.error ? getErrorMessage(body.error.code, body.error.message, locale, register) : t("common.saveFailed"),
    );
  }

  async function add(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset at once, so choosing the same file again after a failure still fires.
    event.target.value = "";
    if (!file) return;
    setPending(true);
    setError(null);

    const encoded = await encodeWorkPhoto(file).catch(() => null);
    if (!encoded) {
      setPending(false);
      setError(t("visitPhotos.notAnImage"));
      return;
    }

    const body = new FormData();
    body.set("file", encoded.file);
    body.set("width", String(encoded.width));
    body.set("height", String(encoded.height));
    const response = await fetch(`/api/v1/visits/${visitId}/photos`, { method: "POST", body });
    setPending(false);
    if (!response.ok) return failure(response);
    router.refresh();
  }

  async function remove(photo: VisitPhotoItem) {
    setPending(true);
    setError(null);
    const response = await fetch(photo.url, { method: "DELETE" });
    setPending(false);
    if (!response.ok) return failure(response);
    router.refresh();
  }

  async function publish(photo: VisitPhotoItem) {
    setPending(true);
    setError(null);
    const response = await fetch(`${photo.url}/gallery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_consent: true }),
    });
    setPending(false);
    if (!response.ok) return failure(response);
    setConfirming(null);
    setConsented(false);
    router.refresh();
  }

  async function unpublish(photo: VisitPhotoItem) {
    setPending(true);
    setError(null);
    const response = await fetch(`${photo.url}/gallery`, { method: "DELETE" });
    setPending(false);
    if (!response.ok) return failure(response);
    router.refresh();
  }

  if (photos.length === 0 && !canWrite) return null;
  const confirmingPhoto = photos.find((photo) => photo.id === confirming) ?? null;

  return (
    <section className="visit-photos" aria-label={t("visitPhotos.title")}>
      <p className="visit-photos-head">
        <strong>{t("visitPhotos.title")}</strong>{" "}
        <span className="muted">{t("visitPhotos.count", { count: photos.length, max: MAX_PHOTOS_PER_VISIT })}</span>
      </p>
      <ul className="visit-photos-grid">
        {photos.map((photo, index) => (
          <li key={photo.id}>
            <a href={photo.url} target="_blank" rel="noreferrer" aria-label={t("visitPhotos.open", { index: index + 1 })}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a studio's own photo behind a session, not a build-time asset. */}
              <img src={photo.url} alt="" loading="lazy" width={photo.width} height={photo.height} />
            </a>
            {photo.published && <span className="visit-photos-shown">{t("visitPhotos.shown")}</span>}
            {canWrite && (
              <button
                type="button"
                className="visit-photos-remove"
                disabled={pending}
                aria-label={t("visitPhotos.remove", { index: index + 1 })}
                onClick={() => remove(photo)}
              >
                ×
              </button>
            )}
          </li>
        ))}
        {canWrite && photos.length < MAX_PHOTOS_PER_VISIT && (
          <li>
            <label className="visit-photos-add">
              <span aria-hidden="true">+</span>
              <span>{pending ? t("common.saving") : t("visitPhotos.add")}</span>
              <input className="sr-only" type="file" accept="image/*" disabled={pending} onChange={add} />
            </label>
          </li>
        )}
      </ul>
      {canWrite && photos.length > 0 && (
        <ul className="visit-photos-actions">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <button
                type="button"
                className="inline-action"
                disabled={pending}
                onClick={() => {
                  if (photo.published) return unpublish(photo);
                  setConfirming(confirming === photo.id ? null : photo.id);
                  setConsented(false);
                }}
              >
                {photo.published
                  ? t("visitPhotos.hide", { index: index + 1 })
                  : t("visitPhotos.show", { index: index + 1 })}
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirmingPhoto && (
        <div className="visit-photos-consent">
          <label>
            <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
            <span>{t("visitPhotos.consent")}</span>
          </label>
          <p className="inline-actions">
            <button type="button" className="inline-action" disabled={pending || !consented} onClick={() => publish(confirmingPhoto)}>
              {t("visitPhotos.publish")}
            </button>
            <button type="button" className="inline-action" disabled={pending} onClick={() => setConfirming(null)}>
              {t("common.cancel")}
            </button>
          </p>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
