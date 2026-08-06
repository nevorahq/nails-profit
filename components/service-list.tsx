"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { formatBasisPoints, formatDuration, formatMoneyMinor } from "@/lib/format";

export type ServiceRow = {
  id: string;
  displayName: string;
  price_minor: number | null;
  duration_minutes: number | null;
  currency: string | null;
  costing:
    | {
        status: "complete";
        contribution_margin_minor: number;
        margin_basis_points: number | null;
        profit_per_hour_minor: number;
      }
    | { status: "incomplete"; reasons: string[] };
};

export function ServiceList({
  services,
  locale,
}: {
  services: ServiceRow[];
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const price = String(data.get("price") ?? "").trim();
    const duration = String(data.get("duration") ?? "").trim();

    const response = await fetch("/api/v1/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: { [locale]: data.get("name") },
        ...(price ? { price_minor: Math.round(Number(price) * 100) } : {}),
        ...(duration ? { duration_minutes: Number(duration) } : {}),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("services.createFailed"));
      setPending(false);
      return;
    }

    form.reset();
    setPending(false);
    router.refresh();
  }

  const incomplete = services.filter((service) => service.costing.status === "incomplete");

  return (
    <>
      {incomplete.length > 0 && (
        <div className="warning-banner">
{t("services.incompleteBanner", { count: incomplete.length })}
        </div>
      )}

      <form className="inline-form" onSubmit={submit}>
        <label>
          {t("services.name")}
          <input name="name" required maxLength={200} placeholder={t("services.namePlaceholder")} />
        </label>
        <label>
          {t("common.price")}
          <input name="price" type="number" step="0.01" min="0" placeholder="600" />
        </label>
        <label>
          {t("services.durationMinutes")}
          <input name="duration" type="number" step="1" min="1" placeholder="90" />
        </label>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("services.creating") : t("services.add")}
        </button>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("services.service")}</th>
            <th>{t("common.price")}</th>
            <th>{t("common.duration")}</th>
            <th>{t("services.youKeep")}</th>
            <th>{t("services.margin")}</th>
            <th>{t("services.perHour")}</th>
          </tr>
        </thead>
        <tbody>
          {services.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t("services.none")}
              </td>
            </tr>
          )}
          {services.map((service) => (
            <tr key={service.id}>
              <td>
                <Link href={`/app/services/${service.id}`}>{service.displayName}</Link>
              </td>
              <td>
                {service.price_minor === null
                  ? "—"
                  : formatMoneyMinor(service.price_minor, service.currency ?? "MDL")}
              </td>
              <td>{formatDuration(service.duration_minutes)}</td>
              {service.costing.status === "complete" ? (
                <>
                  <td className={service.costing.contribution_margin_minor < 0 ? "metric-negative" : ""}>
                    {formatMoneyMinor(
                      service.costing.contribution_margin_minor,
                      service.currency ?? "MDL",
                    )}
                  </td>
                  <td>{formatBasisPoints(service.costing.margin_basis_points)}</td>
                  <td className={service.costing.profit_per_hour_minor < 0 ? "metric-negative" : ""}>
                    {formatMoneyMinor(service.costing.profit_per_hour_minor, service.currency ?? "MDL")}
                  </td>
                </>
              ) : (
                <td colSpan={3}>
                  <span className="badge-warning">
                    {t("common.noData")}: {service.costing.reasons.map((r) => t(`reason.${r}` as MessageKey)).join("; ")}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
