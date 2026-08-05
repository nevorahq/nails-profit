"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type { MaterialRow } from "@/components/material-catalogue";
import {
  costingReasonLabels,
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

export function ServiceDetail({
  service,
  materials,
  displayName,
}: {
  service: ServiceDetailData;
  materials: MaterialRow[];
  displayName: string;
}) {
  const router = useRouter();
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
      setError(payload?.error?.message ?? "Не удалось сохранить");
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
            ← Услуги
          </Link>
          <h1>{displayName}</h1>
        </div>
      </header>

      {error && <div className="form-error">{error}</div>}

      <section className="panel">
        <h2>Цена и длительность</h2>
        <form className="inline-form" onSubmit={saveBasics}>
          <label>
            Цена, {service.currency ?? "MDL"}
            <input
              name="price"
              type="number"
              step="0.01"
              min="0"
              defaultValue={service.price_minor === null ? "" : service.price_minor / 100}
            />
          </label>
          <label>
            Длительность, мин
            <input
              name="duration"
              type="number"
              step="1"
              min="1"
              defaultValue={service.duration_minutes ?? ""}
            />
          </label>
          <button className="primary-button" type="submit" disabled={pending}>
            Сохранить
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Рецептура</h2>
        {materials.length === 0 ? (
          <p className="muted">
            Сначала добавьте материалы в <Link href="/app/materials">каталог</Link>.
          </p>
        ) : (
          <form onSubmit={saveRecipe}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Материал</th>
                  <th>Норма расхода</th>
                  <th>Стоимость</th>
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
                          <span className="badge-warning">нет цены</span>
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
              {pending ? "Сохраняем…" : "Сохранить рецептуру"}
            </button>
            <p className="muted">
              Сохранение создаёт новую версию рецептуры. Прошлые расчёты не меняются.
            </p>
          </form>
        )}
      </section>

      <section className="panel insight-panel">
        <h2>Что остаётся вам</h2>
        {service.costing.status === "incomplete" ? (
          <div className="warning-banner">
            <strong>Расчёт неполный.</strong>
            <ul>
              {service.costing.reasons.map((reason) => (
                <li key={reason}>{costingReasonLabels[reason] ?? reason}</li>
              ))}
            </ul>
            {service.costing.unpriced_material_ids.length > 0 && (
              <p>
                Без цены:{" "}
                {service.costing.unpriced_material_ids
                  .map((id) => materials.find((m) => m.id === id)?.name ?? id)
                  .join(", ")}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="metric-grid">
              <Metric label="Цена услуги" value={formatMoneyMinor(service.costing.price_minor, service.costing.currency)} />
              <Metric label="Материалы" value={`− ${formatMoneyMinor(service.costing.material_cost_minor, service.costing.currency)}`} />
              <Metric label="Комиссия мастера" value={`− ${formatMoneyMinor(service.costing.commission_minor, service.costing.currency)}`} />
              <Metric
                label="Останется вам"
                value={formatMoneyMinor(service.costing.contribution_margin_minor, service.costing.currency)}
                strong
                negative={service.costing.contribution_margin_minor < 0}
              />
              <Metric
                label="Маржа"
                value={formatBasisPoints(service.costing.margin_basis_points)}
                negative={(service.costing.margin_basis_points ?? 0) < 0}
              />
              <Metric
                label="Прибыль в час"
                value={formatMoneyMinor(service.costing.profit_per_hour_minor, service.costing.currency)}
                negative={service.costing.profit_per_hour_minor < 0}
              />
            </div>
            {service.costing.contribution_margin_minor < 0 && (
              <div className="warning-banner">
                Услуга работает в минус: материалы и комиссия стоят больше, чем цена.
              </div>
            )}
            <details className="breakdown">
              <summary>Как это посчитано</summary>
              <p>
                {formatMoneyMinor(service.costing.price_minor, service.costing.currency)} −{" "}
                {formatMoneyMinor(service.costing.material_cost_minor, service.costing.currency)} (материалы) −{" "}
                {formatMoneyMinor(service.costing.commission_minor, service.costing.currency)} (комиссия) ={" "}
                {formatMoneyMinor(service.costing.contribution_margin_minor, service.costing.currency)}
              </p>
              <p>
                Прибыль в час ={" "}
                {formatMoneyMinor(service.costing.contribution_margin_minor, service.costing.currency)} ÷{" "}
                {formatDuration(service.duration_minutes)} × 60 мин
              </p>
              <ul>
                {service.recipe.map((line) => (
                  <li key={line.material_id}>
                    {line.material_name}: {formatQuantity(line.quantity_milli_units, line.base_unit)} ={" "}
                    {line.cost_minor === null
                      ? "цена неизвестна"
                      : formatMoneyMinor(line.cost_minor, service.costing.status === "complete" ? service.costing.currency : "MDL")}
                  </li>
                ))}
              </ul>
              <p className="muted">Версия формулы: {service.costing.formula_version}</p>
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
