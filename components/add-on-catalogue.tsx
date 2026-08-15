"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { MaterialRow } from "@/lib/materials";
import { MaterialPresetPicker } from "@/components/material-preset-picker";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
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
  locale: AppLocale;
  canManage: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  /*
   * The add-on panel: nothing on the page until the header opens it — the
   * header anchors `app/app/add-ons/page.tsx` renders are the *only* control
   * (`.header-action` on a phone, `.calendar-create` on a desktop; a Server
   * Component, so neither can hold this listener itself, delegated on
   * `document` for that reason). Earlier this was a `<details>` whose own
   * `<summary>` stayed visible — and clickable — while closed, which put a
   * second «Добавить опцию» directly under the header's own button. A plain
   * `hidden` section has no such collapsed state to show.
   */
  // Lazy so it reads the real hash on the client's own first render rather
  // than in a follow-up effect — `location` does not exist during the
  // server's render of this "use client" component.
  const [addOpen, setAddOpen] = useState(() => typeof window !== "undefined" && location.hash === "#add-addon");
  const addRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const trigger = (event.target as HTMLElement).closest('a[href="#add-addon"]');
      if (!trigger) return;
      event.preventDefault();
      setAddOpen((open) => !open);
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (addOpen) addRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.querySelectorAll<HTMLAnchorElement>('a.header-action[href="#add-addon"]').forEach((button) => {
      const label = addOpen ? button.dataset.labelOpen : button.dataset.labelClosed;
      if (label) button.setAttribute("aria-label", label);
    });
  }, [addOpen]);

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
      setError(body?.error?.message ?? t("common.saveFailed"));
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

    const ok = await send(
      "/api/v1/add-ons",
      "POST",
      {
        name: { [locale]: data.get("name") },
        price_delta_minor: price === "" ? 0 : Math.round(Number(price) * 100),
        duration_delta_minutes: duration === "" ? 0 : Number(duration),
      },
      form,
    );
    if (ok) setAddOpen(false);
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
        <div className={`compose-wrap${addOpen ? "" : " is-closed"}`} id="add-addon" ref={addRef}>
          <div className="compose-inner">
            <section className="panel">
              <h2>{t("addOns.add")}</h2>
              <form className="inline-form" onSubmit={createAddOn}>
                <label>
                  {t("addOns.name")}
                  <input name="name" required maxLength={200} placeholder={t("addOns.namePlaceholder")} />
                </label>
                <label>
                  {t("addOns.priceDelta", { currency })}
                  <input name="price" type="number" step="0.01" placeholder="100" />
                </label>
                <label>
                  {t("addOns.timeDelta")}
                  <input name="duration" type="number" step="1" placeholder="20" />
                </label>
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("common.add")}
                </button>
              </form>
              <p className="muted">{t("addOns.negativeHint")}</p>
            </section>
          </div>
        </div>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("addOns.addOn")}</th>
            <th>{t("common.price")}</th>
            <th>{t("addOns.time")}</th>
            <th>{t("services.materials")}</th>
            {canManage && <th />}
          </tr>
        </thead>
        <tbody>
          {addOns.length === 0 && (
            <tr>
              <td colSpan={canManage ? 5 : 4} className="muted">
                {t("addOns.none")}
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
                  <span className="muted">{t("addOns.noMaterials")}</span>
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
                    {editing === addOn.id ? t("common.cancel") : t("services.materials")}
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
          <p className="muted">{t("addOns.materialsFirst")}</p>
        ) : (
          <section className="panel">
            <h2>
              {t("addOns.materialsOf", {
                name: addOns.find((a) => a.id === editing)?.displayName ?? "",
              })}
            </h2>
            <form onSubmit={(event) => saveRecipe(editing, event)}>
              <MaterialPresetPicker target="add_on" materials={materials} locale={locale} />
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("common.material")}</th>
                    <th>{t("services.norm")}</th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((material) => {
                    const line = addOns
                      .find((a) => a.id === editing)
                      ?.recipe.find((item) => item.material_id === material.id);
                    const pricedPerService =
                      material.current_price !== null &&
                      material.current_price.costing_mode !== "quantity";
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
                            aria-label={`${t("services.norm")} — ${material.name}`}
                            name={`qty-${material.id}`}
                            type="number"
                            step="0.001"
                            min="0"
                            defaultValue={line ? line.quantity_milli_units / 1000 : pricedPerService ? 1 : ""}
                          />
                          <span className="unit-hint">
                            {pricedPerService ? t("materials.service") : material.base_unit}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button className="primary-button" type="submit" disabled={pending}>
                {t("addOns.saveMaterials")}
              </button>
              <p className="muted">{t("addOns.recipeVersionNote")}</p>
            </form>
          </section>
        ))}
    </>
  );
}
