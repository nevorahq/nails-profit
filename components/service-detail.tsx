"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { roundRatio } from "@/domain/money";
import { formatBasisPoints, formatDuration, formatMoneyMinor } from "@/lib/format";

export type ServiceDetailData = {
  id: string;
  name: Record<string, string>;
  price_minor: number | null;
  duration_minutes: number | null;
  currency: string | null;
  costing:
    | {
        status: "complete";
        formula_version: string;
        currency: string;
        price_minor: number;
        /** With the previewed add-ons, so the formula shown matches the figures. */
        duration_minutes: number;
        commission_minor: number;
        contribution_margin_minor: number;
        margin_basis_points: number | null;
        profit_per_hour_minor: number;
      }
    | { status: "incomplete"; reasons: string[] };
};

/**
 * The share of the month's rent and salaries this service carries.
 *
 * Absent for anyone who may not see fixed costs, and absent when there is no
 * rota to spread them over — in both cases the toggle is not offered rather
 * than offered and empty.
 */
export type FullyLoadedView = {
  /** `YYYY-MM` the rate was taken from, named on screen so it is not a mystery. */
  month: string;
  allocated_fixed_cost_minor: number;
  fixed_cost_rate_minor_per_hour: number;
};

export type ServiceAddOn = {
  id: string;
  displayName: string;
  price_delta_minor: number;
  duration_delta_minutes: number;
};

export function ServiceDetail({
  service,
  displayName,
  addOns,
  linkedAddOnIds,
  selectedAddOnIds,
  fullyLoaded,
  locale,
}: {
  service: ServiceDetailData;
  displayName: string;
  addOns: ServiceAddOn[];
  linkedAddOnIds: string[];
  selectedAddOnIds: string[];
  fullyLoaded: FullyLoadedView | null;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /*
   * Contribution margin is the default and stays the default. It is the figure
   * a price decision is made on — the one that answers "is this service worth
   * doing at all" — while the fully loaded number answers "does the studio
   * cover its rent", which is a question about the month, not about the
   * service. Opening on the second would invite cutting a service that in fact
   * contributes.
   */
  const [withFixedCosts, setWithFixedCosts] = useState(false);

  /*
   * The three figures the toggle actually changes, derived once.
   *
   * Recomputed here rather than fetched: the fully loaded margin is the
   * contribution margin less this service's share of the month's fixed costs,
   * and the server has already sent both. The share itself is allocated on the
   * server, where practical capacity lives.
   */
  const complete = service.costing.status === "complete" ? service.costing : null;
  const fixedShareMinor =
    complete && fullyLoaded && withFixedCosts ? fullyLoaded.allocated_fixed_cost_minor : null;
  const keptMinor = complete
    ? complete.contribution_margin_minor - (fixedShareMinor ?? 0)
    : 0;
  const keptMarginBasisPoints =
    !complete || complete.price_minor === 0
      ? null
      : fixedShareMinor === null
        ? complete.margin_basis_points
        : roundRatio(keptMinor * 10_000, complete.price_minor);
  const keptPerHourMinor = !complete
    ? 0
    : fixedShareMinor === null
      ? complete.profit_per_hour_minor
      : roundRatio(keptMinor * 60, complete.duration_minutes);

  async function saveBasics(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const price = String(data.get("price") ?? "").trim();
    const duration = String(data.get("duration") ?? "").trim();

    const response = await fetch(`/api/v1/services/${service.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        price_minor: price === "" ? null : Math.round(Number(price) * 100),
        duration_minutes: duration === "" ? null : Number(duration),
      }),
    });
    await finish(response);
  }

  async function saveLinkedAddOns(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/v1/services/${service.id}/add-ons`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add_on_ids: data.getAll("linked").map(String) }),
    });
    await finish(response);
  }

  /**
   * The chosen set lives in the URL rather than in component state: the costing
   * is computed on the server, so a shareable link shows the same numbers to
   * whoever opens it.
   */
  function togglePreview(addOnId: string, checked: boolean) {
    const next = checked
      ? [...selectedAddOnIds, addOnId]
      : selectedAddOnIds.filter((id) => id !== addOnId);
    const query = next.length > 0 ? `?add_ons=${next.join(",")}` : "";
    router.push(`/app/services/${service.id}${query}`);
  }

  async function finish(response: Response) {
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("common.saveFailed"));
      setPending(false);
      return;
    }
    setPending(false);
    router.refresh();
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <Link className="text-link" href="/app/services">
            ← {t("services.title")}
          </Link>
          <h1>{displayName}</h1>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}

      <section className="panel">
        <h2>{t("services.priceAndDuration")}</h2>
        <form className="inline-form" onSubmit={saveBasics}>
          <label>
            {t("services.priceIn", { currency: service.currency ?? "MDL" })}
            <input
              name="price"
              type="number"
              step="0.01"
              min="0"
              defaultValue={service.price_minor === null ? "" : service.price_minor / 100}
            />
          </label>
          <label>
            {t("services.durationMinutes")}
            <input
              name="duration"
              type="number"
              step="1"
              min="1"
              defaultValue={service.duration_minutes ?? ""}
            />
          </label>
          <button className="primary-button" type="submit" disabled={pending}>
            {t("common.save")}
          </button>
        </form>
      </section>

      {addOns.length > 0 && (
        <section className="panel">
          <h2>{t("services.addOns")}</h2>
          <form className="inline-form" onSubmit={saveLinkedAddOns}>
            <fieldset className="checkbox-set">
              <legend>{t("services.offeredWith")}</legend>
              {addOns.map((addOn) => (
                <label key={addOn.id} className="radio-row">
                  <input
                    type="checkbox"
                    name="linked"
                    value={addOn.id}
                    defaultChecked={linkedAddOnIds.includes(addOn.id)}
                  />{" "}
                  {addOn.displayName}
                </label>
              ))}
            </fieldset>
            <button className="primary-button" type="submit" disabled={pending}>
              {t("services.saveList")}
            </button>
          </form>
        </section>
      )}

      <section className="panel insight-panel">
        <h2>{t("services.whatYouKeep")}</h2>
        {linkedAddOnIds.length > 0 && (
          <fieldset className="checkbox-set">
            <legend>{t("services.calculateWithAddOns")}</legend>
            {addOns
              .filter((addOn) => linkedAddOnIds.includes(addOn.id))
              .map((addOn) => (
                <label key={addOn.id} className="radio-row">
                  <input
                    type="checkbox"
                    checked={selectedAddOnIds.includes(addOn.id)}
                    onChange={(event) => togglePreview(addOn.id, event.target.checked)}
                  />{" "}
                  {addOn.displayName}
                </label>
              ))}
          </fieldset>
        )}
        {service.costing.status === "incomplete" ? (
          <div className="warning-banner">
            <strong>{t("services.incomplete")}</strong>
            <ul>
              {service.costing.reasons.map((reason) => (
                <li key={reason}>{t(`reason.${reason}` as MessageKey)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {/*
              Offered only when there is a rate to offer, and worded as what is
              subtracted rather than as a mode name: «Fully Loaded» is a term
              from management accounting, and the reader of this screen is a
              salon owner deciding on a price.
            */}
            {fullyLoaded && (
              <fieldset className="checkbox-set costing-view">
                <legend>{t("services.viewMode")}</legend>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="costing-view"
                    checked={!withFixedCosts}
                    onChange={() => setWithFixedCosts(false)}
                  />{" "}
                  {t("services.viewContribution")}
                </label>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="costing-view"
                    checked={withFixedCosts}
                    onChange={() => setWithFixedCosts(true)}
                  />{" "}
                  {t("services.viewFullyLoaded")}
                </label>
              </fieldset>
            )}
            <div className="metric-grid">
              <Metric label={t("services.servicePrice")} value={formatMoneyMinor(service.costing.price_minor, service.costing.currency)} />
              <Metric label={t("services.commission")} value={`− ${formatMoneyMinor(service.costing.commission_minor, service.costing.currency)}`} />
              {fixedShareMinor !== null && (
                <Metric
                  label={t("services.fixedShare")}
                  value={`− ${formatMoneyMinor(fixedShareMinor, service.costing.currency)}`}
                />
              )}
              <Metric
                label={fixedShareMinor === null ? t("services.youKeep") : t("services.afterFixed")}
                value={formatMoneyMinor(keptMinor, service.costing.currency)}
                strong
                negative={keptMinor < 0}
              />
              <Metric
                label={t("services.margin")}
                value={formatBasisPoints(keptMarginBasisPoints)}
                negative={(keptMarginBasisPoints ?? 0) < 0}
              />
              <Metric
                label={t("services.perHour")}
                value={formatMoneyMinor(keptPerHourMinor, service.costing.currency)}
                negative={keptPerHourMinor < 0}
              />
            </div>
            {fullyLoaded && fixedShareMinor !== null && (
              <p className="muted">
                {t("services.fullyLoadedHint", {
                  rate: formatMoneyMinor(
                    fullyLoaded.fixed_cost_rate_minor_per_hour,
                    service.costing.currency,
                  ),
                  // Named as a month, not as `2026-03`: the rate came from a
                  // month of the owner's life, and a key from the query layer
                  // is not how they refer to it.
                  month: new Intl.DateTimeFormat(localeTag(locale), {
                    month: "long",
                    year: "numeric",
                  }).format(new Date(`${fullyLoaded.month}-01T00:00:00.000Z`)),
                })}
              </p>
            )}
            {service.costing.contribution_margin_minor < 0 && (
              <div className="warning-banner">
                {t("services.lossWarning")}
              </div>
            )}
            <details className="breakdown">
              <summary>{t("services.howCounted")}</summary>
              <p>
                {formatMoneyMinor(service.costing.price_minor, service.costing.currency)} −{" "}
                {formatMoneyMinor(service.costing.commission_minor, service.costing.currency)} ({t("services.commissionWord")}) ={" "}
                {formatMoneyMinor(service.costing.contribution_margin_minor, service.costing.currency)}
              </p>
              {fullyLoaded && fixedShareMinor !== null && (
                <p>
                  {t("services.fullyLoadedFormula")}{" "}
                  {formatMoneyMinor(
                    fullyLoaded.fixed_cost_rate_minor_per_hour,
                    service.costing.currency,
                  )}{" "}
                  ÷ 60 {t("common.minutes")} × {formatDuration(service.costing.duration_minutes)} ={" "}
                  {formatMoneyMinor(fixedShareMinor, service.costing.currency)}
                </p>
              )}
              <p>
                {t("services.perHourFormula")}{" "}
                {formatMoneyMinor(keptMinor, service.costing.currency)} ÷{" "}
                {/* The duration the costing used, add-ons included — the base
                    duration would not divide the figure printed beside it. */}
                {formatDuration(service.costing.duration_minutes)} × 60 {t("common.minutes")}
              </p>
              <p className="muted">
                {t("services.formulaVersion", { version: service.costing.formula_version })}
              </p>
            </details>
          </>
        )}
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  strong,
  negative,
}: {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`metric${strong ? " metric-strong" : ""}${negative ? " metric-negative" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
