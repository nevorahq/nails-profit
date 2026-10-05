"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { TipField, tipMinorOf, toMajorUnits } from "@/components/paid-field";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";

/** One sold line of the visit, so a refund can be attached to what it undoes. */
export type AdjustLine = {
  id: string;
  name: string;
  chargedMinor: number;
  refundMinor: number;
};

export function VisitAdjustForm({
  visitId,
  lines,
  currency,
  plannedDurationMinutes,
  actualDurationMinutes,
  tipMinor,
  locale,
}: {
  visitId: string;
  lines: AdjustLine[];
  currency: string;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  /** The tip as it stands, so the field opens on it rather than on nothing. */
  tipMinor: number;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const localeCode = localeTag(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [tipInput, setTipInput] = useState(tipMinor > 0 ? toMajorUnits(tipMinor) : "");
  const nextTip = tipMinorOf(tipInput);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);

    const durationRaw = String(data.get("actual_duration") ?? "").trim();

    /*
     * Every line is sent, including the untouched zeros. A refund is a state
     * rather than an event — «сколько вернули по этой строке» — so sending only
     * the changed ones would make cancelling a refund impossible.
     */
    const refunds = lines.map((line) => ({
      line_id: line.id,
      refund_minor: Math.round((Number(String(data.get(`refund-${line.id}`) ?? "0")) || 0) * 100),
    }));

    const response = await fetch(`/api/v1/visits/${visitId}/adjust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refunds,
        ...(durationRaw ? { actual_duration_minutes: Number(durationRaw) } : {}),
        // Sent only when it changed: a correction of a refund alone must not
        // be recorded as somebody touching the tip.
        ...(nextTip !== null && nextTip !== tipMinor ? { tip_minor: nextTip } : {}),
      }),
    });

    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      // By code first: MISSING_COMMISSION_RULE is worded for who reads it, and
      // the server's own message is English.
      setError(
        payload?.error?.code
          ? getErrorMessage(payload.error.code, payload.error.message ?? t("visits.adjustFailed"), locale, register)
          : (payload?.error?.message ?? t("visits.adjustFailed")),
      );
      return;
    }

    router.refresh();
  }

  return (
    <details className="calendar-subform">
      <summary>{t("closeVisit.modifyDuration")}</summary>
      <form className="inline-form" onSubmit={submit}>
        <label>
          {t("closeVisit.actualMinutes")}
          <input
            name="actual_duration"
            type="number"
            min="1"
            step="1"
            placeholder={String(actualDurationMinutes ?? plannedDurationMinutes)}
            defaultValue={actualDurationMinutes ?? undefined}
          />
        </label>

        <TipField
          id={`tip-${visitId}`}
          value={tipInput}
          currency={currency}
          locale={locale}
          onChange={setTipInput}
        />

        {lines.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("visits.line")}</th>
                <th>{t("visits.charged")}</th>
                <th>{t("visits.refund")}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.name}</td>
                  <td className="muted">{formatMoneyMinor(line.chargedMinor, currency, localeCode)}</td>
                  <td>
                    <input
                      aria-label={`${t("visits.refund")} — ${line.name}`}
                      name={`refund-${line.id}`}
                      type="number"
                      step="0.01"
                      min="0"
                      max={line.chargedMinor / 100}
                      defaultValue={line.refundMinor / 100}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <button className="primary-button" type="submit" disabled={pending || nextTip === null}>
          {pending ? t("common.saving") : t("common.save")}
        </button>
      </form>
    </details>
  );
}
