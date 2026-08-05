"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { formatMoneyMinor } from "@/lib/format";

export type CloseFormService = {
  id: string;
  displayName: string;
  price_minor: number | null;
  duration_minutes: number | null;
  recipe: { material_id: string; material_name: string; base_unit: string; quantity_milli_units: number }[];
};

export type CloseFormAddOn = {
  id: string;
  displayName: string;
  price_delta_minor: number;
  duration_delta_minutes: number;
  serviceIds: string[];
  recipe: { material_id: string; material_name: string; base_unit: string; quantity_milli_units: number }[];
};

/**
 * Closing a visit, the flow Gate 3 times at under a minute on a phone.
 *
 * The actual quantities default to the recipe's norm, so a master who used
 * exactly what the recipe says only picks a service and saves. Only deviations
 * need typing — which is also what makes the deviation figure meaningful rather
 * than a by-product of an empty form.
 */
export function VisitCloseForm({
  services,
  addOns,
  specialists,
  clients,
  currency,
}: {
  services: CloseFormService[];
  addOns: CloseFormAddOn[];
  specialists: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  currency: string;
}) {
  const router = useRouter();
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [selectedAddOns, setSelectedAddOns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const service = services.find((item) => item.id === serviceId) ?? null;
  const availableAddOns = addOns.filter((addOn) => addOn.serviceIds.includes(serviceId));
  const chosen = availableAddOns.filter((addOn) => selectedAddOns.includes(addOn.id));

  /** One row per material, quantities summed, mirroring what the server stores. */
  const materials = mergeRecipeRows([
    ...(service?.recipe ?? []),
    ...chosen.flatMap((addOn) => addOn.recipe),
  ]);

  const price = (service?.price_minor ?? 0) + chosen.reduce((total, a) => total + a.price_delta_minor, 0);
  const duration =
    (service?.duration_minutes ?? 0) + chosen.reduce((total, a) => total + a.duration_delta_minutes, 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);

    const consumption = materials
      .map((material) => ({
        material_id: material.id,
        actual_quantity: Number(String(data.get(`actual-${material.id}`) ?? "").trim()),
      }))
      .filter((entry) => Number.isFinite(entry.actual_quantity));

    const actualDuration = String(data.get("actual_duration") ?? "").trim();
    const clientId = String(data.get("client_id") ?? "");

    const response = await fetch("/api/v1/visits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: serviceId,
        specialist_id: data.get("specialist_id"),
        client_id: clientId === "" ? null : clientId,
        add_on_ids: selectedAddOns,
        ...(actualDuration ? { actual_duration_minutes: Number(actualDuration) } : {}),
        consumption,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Не удалось сохранить визит");
      setPending(false);
      return;
    }

    setPending(false);
    router.push("/app/visits");
    router.refresh();
  }

  if (services.length === 0 || specialists.length === 0) {
    return (
      <div className="warning-banner">
        Чтобы закрыть визит, нужны хотя бы одна <Link href="/app/services">услуга</Link> и один{" "}
        <Link href="/app/specialists">мастер</Link> с правилом комиссии.
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <section className="panel">
        <div className="inline-form">
          <label>
            Услуга
            <select
              name="service_id"
              value={serviceId}
              onChange={(event) => {
                setServiceId(event.target.value);
                setSelectedAddOns([]);
              }}
            >
              {services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Мастер
            <select name="specialist_id">
              {specialists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Клиент
            <select name="client_id" defaultValue="">
              <option value="">без клиента</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Факт. время, мин
            <input name="actual_duration" type="number" min="1" step="1" placeholder={String(duration)} />
          </label>
        </div>

        {availableAddOns.length > 0 && (
          <fieldset className="checkbox-set">
            <legend>Опции</legend>
            {availableAddOns.map((addOn) => (
              <label key={addOn.id} className="radio-row">
                <input
                  type="checkbox"
                  checked={selectedAddOns.includes(addOn.id)}
                  onChange={(event) =>
                    setSelectedAddOns(
                      event.target.checked
                        ? [...selectedAddOns, addOn.id]
                        : selectedAddOns.filter((value) => value !== addOn.id),
                    )
                  }
                />{" "}
                {addOn.displayName}
              </label>
            ))}
          </fieldset>
        )}

        <p className="muted">
          К оплате {formatMoneyMinor(price, currency)}, плановое время {duration} мин.
        </p>
      </section>

      <section className="panel">
        <h2>Фактический расход</h2>
        {materials.length === 0 ? (
          <p className="muted">У этой услуги нет рецептуры — расход записывать нечего.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Материал</th>
                <th>Норма</th>
                <th>Факт</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((material) => (
                <tr key={material.id}>
                  <td>{material.name}</td>
                  <td className="muted">
                    {material.quantity / 1000} {material.unit}
                  </td>
                  <td>
                    <input
                      name={`actual-${material.id}`}
                      type="number"
                      step="0.001"
                      min="0"
                      defaultValue={material.quantity / 1000}
                    />
                    <span className="unit-hint">{material.unit}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Факт подставлен по норме — исправьте только то, что отличается. Пустое поле означает «не
          записано», и тогда маржа визита не считается.
        </p>
      </section>

      {error && <div className="form-error">{error}</div>}

      <button className="primary-button" type="submit" disabled={pending}>
        {pending ? "Сохраняем…" : "Закрыть визит"}
      </button>
    </form>
  );
}

type RecipeRow = { material_id: string; material_name: string; base_unit: string; quantity_milli_units: number };

function mergeRecipeRows(rows: RecipeRow[]) {
  const merged = new Map<string, { name: string; unit: string; quantity: number }>();
  for (const line of rows) {
    const existing = merged.get(line.material_id);
    merged.set(line.material_id, {
      name: line.material_name,
      unit: line.base_unit,
      quantity: (existing?.quantity ?? 0) + line.quantity_milli_units,
    });
  }
  return [...merged.entries()].map(([id, value]) => ({ id, ...value }));
}
