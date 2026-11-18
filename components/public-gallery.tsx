"use client";

import { useMemo, useRef, useState } from "react";

import { getTranslator } from "@/i18n/t";
import type { AppLocale } from "@/i18n/messages";
import type { PublicGalleryPhoto } from "@/lib/public-gallery";

/**
 * The studio's finished work on its booking page: a strip of tiles under the
 * heading, and one photo at a time in a native `<dialog>` — which brings the
 * focus trap, Escape and the backdrop with it, so there is no library here.
 *
 * Every tile is a real button with the photo's caption as its text for a
 * screen reader. The pictures are the studio's own photos behind the booking
 * API, not build-time assets, so a plain `<img>` with its size given is what
 * serves them: the page keeps its shape while they load.
 *
 * «Book» hands the photo's master back to the booking form below
 * (`onBook`), which picks that master and brings the form into view.
 */
export function PublicGallery({
  photos,
  locale,
  onBook,
}: {
  photos: readonly PublicGalleryPhoto[];
  locale: AppLocale;
  onBook: (specialistId: string | null) => void;
}) {
  const t = useMemo(() => getTranslator(locale), [locale]);
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);

  if (photos.length === 0) return null;

  const current = photos[Math.min(index, photos.length - 1)];
  const caption = (photo: PublicGalleryPhoto) =>
    [photo.serviceName, photo.specialistName].filter(Boolean).join(" — ");
  const alt = (photo: PublicGalleryPhoto) =>
    caption(photo) ? t("publicGallery.alt", { caption: caption(photo) }) : t("publicGallery.title");

  function open(next: number) {
    setIndex(next);
    dialog.current?.showModal();
  }

  return (
    <section className="public-gallery" aria-label={t("publicGallery.title")}>
      <h2>{t("publicGallery.title")}</h2>
      <ul className="public-gallery-strip">
        {photos.map((photo, position) => (
          <li key={photo.id}>
            <button type="button" aria-label={t("publicGallery.open", { index: position + 1 })} onClick={() => open(position)}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the studio's own photo served by the booking API, not a build-time asset. */}
              <img src={photo.url} alt={alt(photo)} width={photo.width} height={photo.height} loading="lazy" decoding="async" />
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialog}
        className="public-gallery-dialog"
        aria-label={t("publicGallery.title")}
        // A click on the backdrop lands on the dialog element itself.
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <button type="button" className="public-gallery-close" onClick={() => dialog.current?.close()}>
          {t("publicGallery.close")}
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element -- as above. */}
        <img src={current.url} alt={alt(current)} width={current.width} height={current.height} />
        {caption(current) && <p className="public-gallery-caption">{caption(current)}</p>}
        <div className="public-gallery-nav">
          {photos.length > 1 && (
            <button type="button" aria-label="←" onClick={() => setIndex((index + photos.length - 1) % photos.length)}>
              ←
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              dialog.current?.close();
              onBook(current.specialistId);
            }}
          >
            {current.specialistName ? t("publicGallery.book", { name: current.specialistName }) : t("publicGallery.bookHere")}
          </button>
          {photos.length > 1 && (
            <button type="button" aria-label="→" onClick={() => setIndex((index + 1) % photos.length)}>
              →
            </button>
          )}
        </div>
      </dialog>
    </section>
  );
}
