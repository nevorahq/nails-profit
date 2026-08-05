"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { MaterialRow } from "@/components/material-catalogue";
import { formatDuration, formatMoneyMinor, formatQuantity } from "@/lib/format";

export type AddOnRow = {
  id: string;
  displayName: string;
  price_delta_minor: number;
  duration_delta_minutes: number;
  recipe: { material_id: string; material_name: string; base_unit: string; quantity_milli_units: number }[];
};

/** Signed deltas read better with an explicit sign than as a bare number. */
function signed(value: string, isNegative: boolean) {
  return isNegative ? value : `+${value}`;
}

export function AddOnCatalogue({
  addOns,
  materials,
  currency,
  locale,
  canManage,
}: {
  addOns: AddOnRow[];
  materials: MaterialRow[];
  currency: string;
  locale: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function send(url: string, method: string, payload: unknown, form?: HTMLFormElement) {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? "Не удалось сохранить");
      setPending(false);
      return false;
    }
    form?.reset();
    setPending(false);
    router.refresh();
    return true;
  }

  async function createAddOn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const price = String(data.get("price") ?? "").trim();
    const duration = String(data.get("duration") ?? "").trim();

    await send(
      "/api/v1/add-ons",
      "POST",
      {
        name: { [locale]: data.get("name") },
        price_delta_minor: price === "" ? 0 : Math.round(Number(price) * 100),
        duration_delta_minutes: duration === "" ? 0 : Number(duration),
      },
      form,
    );
  }

  async function saveRecipe(addOnId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const items = materials
      .map((material) => ({
        material_id: material.id,
        quantity: Number(String(data.get(`qty-${material.id}`) ?? "").trim()),
      }))
      .filter((item) => Number.isFinite(item.quantity) && item.quantity > 0);

    if (await send(`/api/v1/add-ons/${addOnId}/recipe`, "PUT", { items })) {
      setEditing(null);
    }
  }

  return (
    <>
      {canManage && (
        <section className="panel">
          <h2>Добавить опцию</h2>
          <form className="inline-form" onSubmit={createAddOn}>
            <label>
              Название
              <input name="name" required maxLength={200} placeholder="Френч" />
            </label>
            <label>
              Изменение цены, {currency}
              <input name="price" type="number" step="0.01" placeholder="100" />
            </label>
            <label>
              Изменение времени, мин
              <input name="duration" type="number" step="1" placeholder="20" />
            </label>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? "Сохраняем…" : "Добавить"}
            </button>
          </form>
          <p className="muted">
            Значения могут быть отрицательными: короткая длина может и стоить меньше, и занимать меньше
            времени.
          </p>
        </section>
      )}

      {error && <div className="form-error">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Опция</th>
            <th>Цена</th>
            <th>Время</th>
            <th>Материалы</th>
            {canManage && <th />}
          </tr>
        </thead>
        <tbody>
          {addOns.length === 0 && (
            <tr>
              <td colSpan={canManage ? 5 : 4} className="muted">
                Опций пока нет.
              </td>
            </tr>
          )}
          {addOns.map((addOn) => (
            <tr key={addOn.id}>
              <td>{addOn.displayName}</td>
              <td className={addOn.price_delta_minor < 0 ? "metric-negative" : ""}>
                {signed(
                  formatMoneyMinor(addOn.price_delta_minor, currency),
                  addOn.price_delta_minor < 0,
                )}
              </td>
              <td className={addOn.duration_delta_minutes < 0 ? "metric-negative" : ""}>
                {addOn.duration_delta_minutes === 0
                  ? "—"
                  : signed(
                      formatDuration(Math.abs(addOn.duration_delta_minutes)),
                      addOn.duration_delta_minutes < 0,
                    )}
              </td>
              <td>
                {addOn.recipe.length === 0 ? (
                  <span className="muted">без материалов</span>
                ) : (
                  <ul className="compact-list">
                    {addOn.recipe.map((line) => (
                      <li key={line.material_id}>
                        {line.material_name}:{" "}
                        {formatQuantity(line.quantity_milli_units, line.base_unit)}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              {canManage && (
                <td>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setEditing(editing === addOn.id ? null : addOn.id)}
                  >
                    {editing === addOn.id ? "Отмена" : "Материалы"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {canManage &&
        editing &&
        (materials.length === 0 ? (
          <p className="muted">Сначала добавьте материалы в каталог.</p>
        ) : (
          <section className="panel">
            <h2>Материалы опции «{addOns.find((a) => a.id === editing)?.displayName}»</h2>
            <form onSubmit={(event) => saveRecipe(editing, event)}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Материал</th>
                    <th>Норма расхода</th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((material) => {
                    const line = addOns
                      .find((a) => a.id === editing)
                      ?.recipe.find((item) => item.material_id === material.id);
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
                            defaultValue={line ? line.quantity_milli_units / 1000 : ""}
                          />
                          <span className="unit-hint">{material.base_unit}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button className="primary-button" type="submit" disabled={pending}>
                Сохранить материалы
              </button>
              <p className="muted">Сохранение создаёт новую версию рецептуры опции.</p>
            </form>
          </section>
        ))}
    </>
  );
}
