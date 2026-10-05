"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { materialsCostingModes, type MaterialsCostingMode } from "@/domain/materials-mode";
import type { AppLocale } from "@/i18n/messages";
import { getErrorMessage } from "@/i18n/messages";
import { type MessageKey } from "@/i18n/t";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { localeTag } from "@/i18n/translate";

/**
 * «Как считать материалы» in the settings: the mode now, any change already
 * chosen for a later month, and the form to choose one.
 *
 * The month is picked, not the day — a mode applies to whole months, and a
 * month already behind the current one is not offered, because the server
 * refuses it (`app/api/v1/organizations/materials-mode`).
 */
export function MaterialsModeSetting({
  current,
  scheduled,
  currentMonth,
  canEdit,
  locale,
}: Readonly<{
  current: MaterialsCostingMode;
  /** Changes after the current month, oldest first. */
  scheduled: readonly Readonly<{ mode: MaterialsCostingMode; month: string }>[];
  /** `YYYY-MM`, in the studio's own zone. */
  currentMonth: string;
  canEdit: boolean;
  locale: AppLocale;
}>) {
  const t = useTranslator(locale);
  const register = useRegister();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const modeName = (mode: MaterialsCostingMode) => t(`materialsMode.${mode}` as MessageKey);
  const monthName = (month: string) =>
    new Intl.DateTimeFormat(localeTag(locale), { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${month}-01T00:00:00.000Z`),
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/organizations/materials-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: data.get("mode"), effective_month: data.get("month") }),
    }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      const payload = await response?.json().catch(() => null);
      const code = payload?.error?.code;
      setError(code ? getErrorMessage(code, t("common.saveFailed"), locale, register) : t("common.saveFailed"));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <section className="panel" id="materials-mode">
      <h2>{t("materialsMode.title")}</h2>
      <p className="muted">{t("materialsMode.lead")}</p>
      <p>
        <strong>{t("materialsMode.now", { mode: modeName(current) })}</strong>
      </p>
      {scheduled.map((change) => (
        <p key={change.month}>{t("materialsMode.scheduled", { month: monthName(change.month), mode: modeName(change.mode) })}</p>
      ))}

      {canEdit && (
        <form className="inline-form" onSubmit={submit}>
          <label>
            {t("materialsMode.mode")}
            <select name="mode" defaultValue={current === "purchases" ? "per_service" : "purchases"} disabled={pending}>
              {materialsCostingModes.map((mode) => (
                <option key={mode} value={mode}>
                  {modeName(mode)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("materialsMode.from")}
            <input name="month" type="month" required min={currentMonth} defaultValue={currentMonth} disabled={pending} />
          </label>
          <button className="primary-button" type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("common.save")}
          </button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="muted" role="status">
          {t("materialsMode.saved")}
        </p>
      )}
    </section>
  );
}
