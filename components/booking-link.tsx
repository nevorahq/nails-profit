"use client";

import { useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * The address clients book at, handed over rather than described.
 *
 * A studio that has just registered has a working booking page and no idea
 * where it is: the link lives on «Онлайн-запись», two screens away, and the one
 * thing the owner wants to do with it — send it to somebody — needs it on the
 * clipboard rather than on a screen.
 *
 * The absolute URL is built in the browser, because the server does not
 * reliably know which host it was reached on, and a link to the wrong one is
 * worse than none.
 */
export function BookingLink({ slug, locale }: { slug: string; locale: AppLocale }) {
  const t = getTranslator(locale);
  const [copied, setCopied] = useState(false);
  const path = `/book/${slug}`;

  async function copy() {
    await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <p className="booking-link">
      <a className="text-link" href={path}>
        {path}
      </a>
      <button type="button" className="secondary-button" onClick={copy}>
        {copied ? t("firstNumbers.copied") : t("firstNumbers.copyLink")}
      </button>
    </p>
  );
}
