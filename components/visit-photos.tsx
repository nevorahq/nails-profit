"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { MAX_PHOTOS_PER_VISIT } from "@/domain/visit-photos";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { encodeWorkPhoto } from "@/lib/work-photo-image";

export type VisitPhotoItem = Readonly<{ id: string; url: string; width: number; height: number }>;

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

  if (photos.length === 0 && !canWrite) return null;

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
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
