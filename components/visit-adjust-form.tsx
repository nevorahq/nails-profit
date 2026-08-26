"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
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
  locale,
}: {
  visitId: string;
  lines: AdjustLine[];
  currency: string;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const localeCode = localeTag(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      }),
    });

    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("visits.adjustFailed"));
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

        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("common.save")}
        </button>
      </form>
    </details>
  );
}
