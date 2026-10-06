"use client";

import { type ReactNode, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { useTranslator } from "@/components/lexicon-provider";

/**
 * Deleting the studio and deleting the account, folded away at the bottom of
 * Настройки. They are the two things on that page that cannot be taken back,
 * and a heading each in the middle of the settings put them one scroll from the
 * ones people come for. The confirmations inside are unchanged.
 *
 * A native `<details>`: keyboard and screen readers get the disclosure for
 * free, and a closed one still keeps its contents out of the tab order.
 */
export function DangerZone({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  const t = useTranslator(locale);
  const [open, setOpen] = useState(false);

  return (
    <details
      className="danger-details"
      id="danger-zone"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("settings.dangerZone")}</summary>
      <p className="muted">{t("settings.dangerHint")}</p>
      {children}
    </details>
  );
}
