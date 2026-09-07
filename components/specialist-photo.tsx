"use client";

import { useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AVATAR_EDGE_PIXELS, avatarUrl, squareCrop } from "@/domain/avatar-image";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * The face on a master's card, and the two controls that set it.
 *
 * A circle with a letter in it until there is a photograph, which is what every
 * other screen already draws — the calendar's day columns and the visits list
 * both fall back the same way, so a studio that sets a face here sees it
 * everywhere without a second decision.
 *
 * The picture is squared and shrunk in the browser before it is sent. A phone
 * photograph is four megabytes of a room; what is drawn is a 40rem circle. The
 * endpoint would refuse the four megabytes, correctly and uselessly — the owner
 * would learn that their photo is "too large" and have nowhere to make it
 * smaller. Re-encoding first means the file that arrives is the one that will be
 * looked at, and the size limit is left to catch what this cannot.
 */
export function SpecialistPhoto({
  specialistId,
  name,
  version,
  canManage,
  href,
  withName = true,
  locale,
}: {
  specialistId: string;
  name: string;
  /** The stored photo's version, or null when there is none. Also cache-busts. */
  version: number | null;
  canManage: boolean;
  /**
   * Where the name leads, when it leads anywhere. The list gives it the
   * master's own page; on that page the name is already the heading, so it
   * stays plain text rather than linking to where the reader is standing.
   */
  href?: string;
  /**
   * Whether the name is written beside the circle. The list writes it — that is
   * the row's first cell. The master's own page does not: the name is the
   * heading directly above, and printing it twice would read as two people.
   */
  withName?: boolean;
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
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

    const squared = await square(file).catch(() => null);
    if (!squared) {
      setError(t("specialists.photoNotAnImage"));
      setPending(false);
      return;
    }

    const body = new FormData();
    body.set("file", squared);
    const response = await fetch(`/api/v1/specialists/${specialistId}/avatar`, {
      method: "POST",
      body,
    });
    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("common.saveFailed"));
      return;
    }
    router.refresh();
  }

  async function remove() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/specialists/${specialistId}/avatar`, { method: "DELETE" });
    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("common.saveFailed"));
      return;
    }
    router.refresh();
  }

  return (
    <div className="specialist-photo">
      <span className="avatar" aria-hidden="true">
        {version === null ? (
          name.trim().slice(0, 1).toUpperCase() || "?"
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a studio's own photo, not a build-time asset.
          <img src={avatarUrl(specialistId, version) as string} alt="" />
        )}
      </span>

      <div className="specialist-photo-name">
        {withName && (href ? <Link href={href}>{name}</Link> : <span>{name}</span>)}
        {canManage && (
          <div className="inline-actions">
            {/*
              A label rather than a button that clicks a hidden input: the file
              picker is the input's own, and wrapping it names it for a screen
              reader without a second element to keep in step. The input is
              taken out of the layout by `sr-only` rather than by `hidden`,
              which would also take it out of the focus order.
            */}
            <label className="inline-action">
              {version === null ? t("specialists.photoAdd") : t("specialists.photoReplace")}
              <input
                className="sr-only"
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!canManage || pending}
                onChange={upload}
              />
            </label>
            {version !== null && (
              <button className="inline-action danger" type="button" disabled={pending} onClick={remove}>
                {t("specialists.photoRemove")}
              </button>
            )}
          </div>
        )}
        {pending && <span className="muted">{t("common.saving")}</span>}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The centre square of a picture, at the size a circle actually shows.
 *
 * WebP first because it is a third of the bytes at the same quality, PNG when
 * the browser cannot encode one — `toBlob` answers with a PNG rather than
 * failing when it does not know the type asked for, so the result is checked
 * instead of assumed. Both are formats the endpoint reads from the signature,
 * so whichever arrives is stored as what it is.
 */
async function square(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const crop = squareCrop(bitmap.width, bitmap.height);

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_EDGE_PIXELS;
  canvas.height = AVATAR_EDGE_PIXELS;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser has no 2d canvas");
  context.drawImage(
    bitmap,
    crop.x,
    crop.y,
    crop.size,
    crop.size,
    0,
    0,
    AVATAR_EDGE_PIXELS,
    AVATAR_EDGE_PIXELS,
  );
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (!blob) throw new Error("This browser encoded nothing");

  const extension = blob.type === "image/webp" ? "webp" : "png";
  return new File([blob], `avatar.${extension}`, { type: blob.type });
}
