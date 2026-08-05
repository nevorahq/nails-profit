"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { MaterialRow } from "@/components/material-catalogue";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import {
  formatBasisPoints,
  formatDuration,
  formatMoneyMinor,
  formatQuantity,
} from "@/lib/format";

export type ServiceDetailData = {
  id: string;
  name: Record<string, string>;
  price_minor: number | null;
  duration_minutes: number | null;
  currency: string | null;
  recipe: {
    material_id: string;
    material_name: string;
    base_unit: string;
    quantity_milli_units: number;
    cost_minor: number | null;
  }[];
  costing:
    | {
        status: "complete";
        formula_version: string;
        currency: string;
        price_minor: number;
        material_cost_minor: number;
        commission_minor: number;
        contribution_margin_minor: number;
        margin_basis_points: number | null;
        profit_per_hour_minor: number;
      }
    | { status: "incomplete"; reasons: string[]; unpriced_material_ids: string[] };
};

export type ServiceAddOn = {
  id: string;
  displayName: string;
  price_delta_minor: number;
  duration_delta_minutes: number;
};

export function ServiceDetail({
  service,
  materials,
  displayName,
  addOns,
  linkedAddOnIds,
  selectedAddOnIds,
  locale,
}: {
  service: ServiceDetailData;
  materials: MaterialRow[];
  displayName: string;
  addOns: ServiceAddOn[];
  linkedAddOnIds: string[];
  selectedAddOnIds: string[];
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

  async function saveRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);

    const items = materials
      .map((material) => ({
        material_id: material.id,
        quantity: Number(String(data.get(`qty-${material.id}`) ?? "").trim()),
      }))
      .filter((item) => Number.isFinite(item.quantity) && item.quantity > 0);

    const response = await fetch(`/api/v1/services/${service.id}/recipe`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    await finish(response);
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

  const quantities = new Map(service.recipe.map((line) => [line.material_id, line.quantity_milli_units]));

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

      {error && <div className="form-error">{error}</div>}

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

      <section className="panel">
        <h2>{t("services.recipe")}</h2>
        {materials.length === 0 ? (
          <p className="muted">
            {t("services.materialsFirst", { catalogue: t("services.catalogue") })}
          </p>
        ) : (
          <form onSubmit={saveRecipe}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("common.material")}</th>
                  <th>{t("services.norm")}</th>
                  <th>{t("services.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((material) => {
                  const line = service.recipe.find((item) => item.material_id === material.id);
                  return (
                    <tr key={material.id}>
                      <td>
                        {material.name}
                        {material.current_price === null && (
                          <span className="badge-warning">{t("common.noPrice")}</span>
                        )}
                      </td>
                      <td>
                        <input
                          name={`qty-${material.id}`}
                          type="number"
                          step="0.001"
                          min="0"
                          defaultValue={
                            quantities.has(material.id)
                              ? quantities.get(material.id)! / 1000
                              : ""
                          }
                        />
                        <span className="unit-hint">{material.base_unit}</span>
                      </td>
                      <td>
                        {line?.cost_minor != null
                          ? formatMoneyMinor(line.cost_minor, service.currency ?? "MDL")
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("services.saveRecipe")}
            </button>
            <p className="muted">
              {t("services.recipeVersionNote")}
            </p>
          </form>
        )}
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
            {service.costing.unpriced_material_ids.length > 0 && (
              <p>
                {t("services.withoutPrice")}{" "}
                {service.costing.unpriced_material_ids
                  .map((id) => materials.find((m) => m.id === id)?.name ?? id)
                  .join(", ")}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="metric-grid">
              <Metric label={t("services.servicePrice")} value={formatMoneyMinor(service.costing.price_minor, service.costing.currency)} />
              <Metric label={t("services.materials")} value={`− ${formatMoneyMinor(service.costing.material_cost_minor, service.costing.currency)}`} />
              <Metric label={t("services.commission")} value={`− ${formatMoneyMinor(service.costing.commission_minor, service.costing.currency)}`} />
              <Metric
                label={t("services.youKeep")}
                value={formatMoneyMinor(service.costing.contribution_margin_minor, service.costing.currency)}
                strong
                negative={service.costing.contribution_margin_minor < 0}
              />
              <Metric
                label={t("services.margin")}
                value={formatBasisPoints(service.costing.margin_basis_points)}
                negative={(service.costing.margin_basis_points ?? 0) < 0}
              />
              <Metric
                label={t("services.perHour")}
                value={formatMoneyMinor(service.costing.profit_per_hour_minor, service.costing.currency)}
                negative={service.costing.profit_per_hour_minor < 0}
              />
            </div>
            {service.costing.contribution_margin_minor < 0 && (
              <div className="warning-banner">
                {t("services.lossWarning")}
              </div>
            )}
            <details className="breakdown">
              <summary>{t("services.howCounted")}</summary>
              <p>
                {formatMoneyMinor(service.costing.price_minor, service.costing.currency)} −{" "}
                {formatMoneyMinor(service.costing.material_cost_minor, service.costing.currency)} ({t("services.materialsWord")}) −{" "}
                {formatMoneyMinor(service.costing.commission_minor, service.costing.currency)} ({t("services.commissionWord")}) ={" "}
                {formatMoneyMinor(service.costing.contribution_margin_minor, service.costing.currency)}
              </p>
              <p>
                {t("services.perHourFormula")}{" "}
                {formatMoneyMinor(service.costing.contribution_margin_minor, service.costing.currency)} ÷{" "}
                {formatDuration(service.duration_minutes)} × 60 {t("common.minutes")}
              </p>
              <ul>
                {service.recipe.map((line) => (
                  <li key={line.material_id}>
                    {line.material_name}: {formatQuantity(line.quantity_milli_units, line.base_unit)} ={" "}
                    {line.cost_minor === null
                      ? t("services.priceUnknown")
                      : formatMoneyMinor(line.cost_minor, service.costing.status === "complete" ? service.costing.currency : "MDL")}
                  </li>
                ))}
              </ul>
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
