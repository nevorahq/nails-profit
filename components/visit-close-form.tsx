"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { formatMoneyMinor } from "@/lib/format";

export type CloseFormService = {
  id: string;
  displayName: string;
  price_minor: number | null;
  duration_minutes: number | null;
};

export type CloseFormAddOn = {
  id: string;
  displayName: string;
  price_delta_minor: number;
  duration_delta_minutes: number;
  serviceIds: string[];
};

/**
 * Closing a visit, the flow Gate 3 times at under a minute on a phone.
 *
 * Picking a service and saving is the whole of it: the price, the duration and
 * the commission all come from the catalogue, and only what actually differed
 * from the plan — a longer visit, a card instead of cash — needs touching.
 */
export function VisitCloseForm({
  services,
  addOns,
  specialists,
  clients,
  paymentMethods,
  currency,
  locale,
}: {
  services: CloseFormService[];
  addOns: CloseFormAddOn[];
  specialists: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  /** Empty when the studio has entered none; the field is then not shown. */
  paymentMethods: { id: string; name: string; is_default: boolean }[];
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

  const price = (service?.price_minor ?? 0) + chosen.reduce((total, a) => total + a.price_delta_minor, 0);
  const duration =
    (service?.duration_minutes ?? 0) + chosen.reduce((total, a) => total + a.duration_delta_minutes, 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Generate on the user event, not during render. The same value survives a
    // failed request and makes an explicit retry idempotent.
    completionKey.current ??= globalThis.crypto.randomUUID();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);

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

      {error && <div className="form-error" role="alert">{error}</div>}

      <button className="primary-button" type="submit" disabled={pending}>
        {pending ? t("common.saving") : t("closeVisit.title")}
      </button>
    </form>
  );
}
