"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { formatMoneyMinor } from "@/lib/format";
import { materialCostMinor } from "@/domain/units";

export type CloseFormService = {
  id: string;
  displayName: string;
  price_minor: number | null;
  duration_minutes: number | null;
  standard_profile_configured: boolean;
  recipe: RecipeRow[];
};

export type CloseFormAddOn = {
  id: string;
  displayName: string;
  price_delta_minor: number;
  duration_delta_minutes: number;
  serviceIds: string[];
  standard_profile_configured: boolean;
  recipe: RecipeRow[];
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
  paymentMethods,
  extraMaterials,
  currency,
  locale,
}: {
  services: CloseFormService[];
  addOns: CloseFormAddOn[];
  specialists: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  /** Empty when the studio has entered none; the field is then not shown. */
  paymentMethods: { id: string; name: string; is_default: boolean }[];
  extraMaterials: { id: string; name: string; base_unit: string }[];
  currency: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [selectedAddOns, setSelectedAddOns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const completionKey = useRef<string | null>(null);

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
  const standardProfileConfigured =
    Boolean(service?.standard_profile_configured) &&
    chosen.every((addOn) => addOn.standard_profile_configured);
  const standardMaterialCostMinor =
    materials.some((material) => material.costMinor === null)
      ? null
      : materials.reduce((total, material) => total + material.costMinor!, 0);
  const availableExtraMaterials = extraMaterials.filter(
    (option) => !materials.some((material) => material.id === option.id),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Generate on the user event, not during render. The same value survives a
    // failed request and makes an explicit retry idempotent.
    completionKey.current ??= globalThis.crypto.randomUUID();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);

    const consumption = materials.flatMap((material) => {
      const raw = String(data.get(`actual-${material.id}`) ?? "").trim();
      if (raw === "") return [];
      const quantity = Number(raw);
      return Number.isFinite(quantity)
        ? [{ material_id: material.id, actual_quantity: quantity }]
        : [];
    });
    const extraMaterialId = String(data.get("extra_material_id") ?? "").trim();
    const extraQuantityRaw = String(data.get("extra_quantity") ?? "").trim();
    const extraQuantity = Number(extraQuantityRaw);
    if (extraMaterialId && extraQuantityRaw && Number.isFinite(extraQuantity) && extraQuantity > 0) {
      consumption.push({ material_id: extraMaterialId, actual_quantity: extraQuantity });
    }

    const actualDuration = String(data.get("actual_duration") ?? "").trim();
    const clientId = String(data.get("client_id") ?? "");
    // "" is the cash option and means null — an explicit "no fee", not an
    // omission. Omitting the field entirely would ask for the default method.
    const paymentMethodId = String(data.get("payment_method_id") ?? "");

    const response = await fetch("/api/v1/visits", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": completionKey.current,
      },
      body: JSON.stringify({
        service_id: serviceId,
        specialist_id: data.get("specialist_id"),
        client_id: clientId === "" ? null : clientId,
        add_on_ids: selectedAddOns,
        ...(actualDuration ? { actual_duration_minutes: Number(actualDuration) } : {}),
        ...(paymentMethods.length > 0
          ? { payment_method_id: paymentMethodId === "" ? null : paymentMethodId }
          : {}),
        consumption,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("closeVisit.saveFailed"));
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
        {t("closeVisit.needsSetup", {
          service: t("services.service").toLowerCase(),
          specialist: t("closeVisit.specialist"),
        })}
        <span className="button-row">
          <Link className="text-link" href="/app/services">
            {t("services.title")}
          </Link>
          <Link className="text-link" href="/app/specialists">
            {t("specialists.title")}
          </Link>
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <section className="panel">
        <div className="inline-form">
          <label>
            {t("services.service")}
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
            {t("specialists.specialist")}
            <select name="specialist_id">
              {specialists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("closeVisit.client")}
            <select name="client_id" defaultValue="">
              <option value="">{t("closeVisit.noClient")}</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("closeVisit.actualMinutes")}
            <input name="actual_duration" type="number" min="1" step="1" placeholder={String(duration)} />
          </label>
          {/*
            Shown only to a studio that has entered a method — asking «чем
            оплачено» when the only possible answer is cash is a field that
            costs a second on every visit and answers nothing. The default is
            pre-selected, so the usual case stays one tap.
          */}
          {paymentMethods.length > 0 && (
            <label>
              {t("payment.choose")}
              <select
                name="payment_method_id"
                defaultValue={paymentMethods.find((method) => method.is_default)?.id ?? ""}
              >
                <option value="">{t("payment.cash")}</option>
                {paymentMethods.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {availableAddOns.length > 0 && (
          <fieldset className="checkbox-set">
            <legend>{t("closeVisit.addOns")}</legend>
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
          {t("closeVisit.dueLine", { amount: formatMoneyMinor(price, currency), duration })}
        </p>
      </section>

      <section className="panel">
        <h2>{t("closeVisit.materials")}</h2>
        {!standardProfileConfigured ? (
          <p className="warning-banner">{t("closeVisit.noRecipe")}</p>
        ) : standardMaterialCostMinor === null ? (
          <p className="warning-banner">{t("closeVisit.unknownMaterialCost")}</p>
        ) : (
          <p className="visit-card-revenue">
            <span>{t("closeVisit.standardUse")}</span>
            <strong>≈ {formatMoneyMinor(standardMaterialCostMinor, currency)}</strong>
          </p>
        )}

        {materials.length > 0 && (
          <details className="calendar-subform">
            <summary>{t("closeVisit.modifyUse")}</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("common.material")}</th>
                <th>{t("closeVisit.norm")}</th>
                <th>{t("closeVisit.actual")}</th>
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
                      aria-label={`${t("closeVisit.actual")} — ${material.name}`}
                      name={`actual-${material.id}`}
                      type="number"
                      step="0.001"
                      min="0"
                      placeholder={String(material.quantity / 1000)}
                    />
                    <span className="unit-hint">{material.unit}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {availableExtraMaterials.length > 0 && (
            <fieldset className="checkbox-set">
              <legend>{t("visits.extraMaterial")}</legend>
              <label>
                {t("common.material")}
                <select name="extra_material_id" defaultValue="">
                  <option value="">—</option>
                  {availableExtraMaterials.map((material) => (
                    <option key={material.id} value={material.id}>
                      {material.name} ({material.base_unit})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("closeVisit.actual")}
                <input name="extra_quantity" type="number" step="0.001" min="0.001" />
              </label>
            </fieldset>
          )}
          <p className="muted">{t("closeVisit.overrideNote")}</p>
          </details>
        )}
      </section>

      {error && <div className="form-error" role="alert">{error}</div>}

      <button className="primary-button" type="submit" disabled={pending}>
        {pending ? t("common.saving") : t("closeVisit.title")}
      </button>
    </form>
  );
}

type RecipeRow = {
  material_id: string;
  material_name: string;
  base_unit: string;
  quantity_milli_units: number;
  package_price_minor: number | null;
  package_size_milli_units: number | null;
};

function mergeRecipeRows(rows: RecipeRow[]) {
  const merged = new Map<
    string,
    {
      name: string;
      unit: string;
      quantity: number;
      packagePriceMinor: number | null;
      packageSizeMilliUnits: number | null;
    }
  >();
  for (const line of rows) {
    const existing = merged.get(line.material_id);
    merged.set(line.material_id, {
      name: line.material_name,
      unit: line.base_unit,
      quantity: (existing?.quantity ?? 0) + line.quantity_milli_units,
      packagePriceMinor: line.package_price_minor,
      packageSizeMilliUnits: line.package_size_milli_units,
    });
  }
  return [...merged.entries()].map(([id, value]) => ({
    id,
    ...value,
    costMinor:
      value.packagePriceMinor === null || value.packageSizeMilliUnits === null
        ? null
        : materialCostMinor(value.packagePriceMinor, value.packageSizeMilliUnits, value.quantity),
  }));
}
