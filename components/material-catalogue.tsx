"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { formatMoneyMinor, formatQuantity } from "@/lib/format";

export type MaterialRow = {
  id: string;
  name: string;
  base_unit: string;
  current_price: {
    package_price_minor: number;
    package_size_milli_units: number;
    currency: string;
    base_unit_cost_minor: number | null;
  } | null;
};

export function MaterialCatalogue({
  materials,
  locale,
}: {
  materials: MaterialRow[];
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
    const form = event.currentTarget;
    const data = new FormData(form);

    const price = String(data.get("price") ?? "").trim();
    const size = String(data.get("size") ?? "").trim();

    const response = await fetch("/api/v1/materials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        base_unit: data.get("base_unit"),
        // Price is optional: a material may be catalogued before anyone knows
        // what it cost. It will simply show as missing until filled in.
        ...(price && size
          ? { package_price_minor: Math.round(Number(price) * 100), package_size: Number(size) }
          : {}),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("materials.saveFailed"));
      setPending(false);
      return;
    }

    form.reset();
    setPending(false);
    router.refresh();
  }

  const missingPrice = materials.filter((material) => material.current_price === null).length;

  return (
    <>
      {missingPrice > 0 && (
        <div className="warning-banner">
{t("materials.missingPriceBanner", { count: missingPrice })}
        </div>
      )}

      <form className="inline-form" onSubmit={submit}>
        <label>
          {t("materials.name")}
          <input name="name" required maxLength={200} placeholder={t("materials.namePlaceholder")} />
        </label>
        <label>
          {t("materials.unit")}
          <select name="base_unit" defaultValue="ml">
            <option value="ml">{t("unit.ml")}</option>
            <option value="g">{t("unit.g")}</option>
            <option value="piece">{t("unit.piece")}</option>
          </select>
        </label>
        <label>
          {t("materials.packagePrice")}
          <input name="price" type="number" step="0.01" min="0" placeholder="240" />
        </label>
        <label>
          {t("materials.packageSize")}
          <input name="size" type="number" step="0.001" min="0" placeholder="15" />
        </label>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("common.add")}
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("common.material")}</th>
            <th>{t("materials.package")}</th>
            <th>{t("materials.packagePrice")}</th>
            <th>{t("materials.unitCost")}</th>
          </tr>
        </thead>
        <tbody>
          {materials.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                {t("materials.none")}
              </td>
            </tr>
          )}
          {materials.map((material) => (
            <tr key={material.id}>
              <td>{material.name}</td>
              <td>
                {material.current_price
                  ? formatQuantity(material.current_price.package_size_milli_units, material.base_unit)
                  : "—"}
              </td>
              <td>
                {material.current_price
                  ? formatMoneyMinor(
                      material.current_price.package_price_minor,
                      material.current_price.currency,
                    )
                  : <span className="badge-warning">{t("materials.priceMissing")}</span>}
              </td>
              <td>
                {material.current_price?.base_unit_cost_minor !== null &&
                material.current_price !== null
                  ? `${formatMoneyMinor(material.current_price.base_unit_cost_minor!, material.current_price.currency)} / ${material.base_unit}`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
