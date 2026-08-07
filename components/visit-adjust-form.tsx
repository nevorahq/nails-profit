"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

export type AdjustMaterial = {
  materialId: string;
  materialName: string;
  baseUnit: string;
  normativeQuantityMilliUnits: number;
  actualQuantityMilliUnits: number | null;
};

export function VisitAdjustForm({
  visitId,
  materials,
  plannedDurationMinutes,
  actualDurationMinutes,
  locale,
}: {
  visitId: string;
  materials: AdjustMaterial[];
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);

    const consumption = materials.map((m) => {
      const raw = String(data.get(`actual-${m.materialId}`) ?? "").trim();
      return {
        material_id: m.materialId,
        actual_quantity: raw === "" ? null : Number(raw),
      };
    });

    const durationRaw = String(data.get("actual_duration") ?? "").trim();

    const response = await fetch(`/api/v1/visits/${visitId}/adjust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consumption,
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
      <summary>{t("visits.enterConsumption")}</summary>
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

        {materials.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("common.material")}</th>
                <th>{t("closeVisit.norm")}</th>
                <th>{t("closeVisit.actual")}</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.materialId}>
                  <td>{m.materialName}</td>
                  <td className="muted">
                    {m.normativeQuantityMilliUnits / 1000} {m.baseUnit}
                  </td>
                  <td>
                    <input
                      aria-label={`${t("closeVisit.actual")} — ${m.materialName}`}
                      name={`actual-${m.materialId}`}
                      type="number"
                      step="0.001"
                      min="0"
                      defaultValue={
                        m.actualQuantityMilliUnits !== null
                          ? m.actualQuantityMilliUnits / 1000
                          : m.normativeQuantityMilliUnits / 1000
                      }
                    />
                    <span className="unit-hint">{m.baseUnit}</span>
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
