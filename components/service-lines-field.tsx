"use client";

import { MAX_SERVICES } from "@/domain/service-limit";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * The services of one sitting, each with its own add-ons.
 *
 * Shared by the two screens that describe what a client had done — closing a
 * visit and booking from the calendar — because both now take a manicure and a
 * pedicure in one go, and the pairing of an add-on with its service is the one
 * thing the server cannot guess afterwards. One service is still one select and
 * nothing else; «+ ещё услуга» is there for the second.
 */

export type PickerService = Readonly<{
  id: string;
  name: string;
  /** Absent where the screen quotes no price — the calendar, before closing. */
  priceMinor?: number;
  durationMinutes?: number | null;
}>;

export type PickerAddOn = Readonly<{
  id: string;
  name: string;
  priceDeltaMinor?: number;
  durationDeltaMinutes?: number;
  /** The services it is offered with; null offers it with any. */
  serviceIds: readonly string[] | null;
}>;

export type ServiceLine = Readonly<{ serviceId: string; addOnIds: readonly string[] }>;

export function addOnsFor(serviceId: string, addOns: readonly PickerAddOn[]): PickerAddOn[] {
  return addOns.filter((addOn) => addOn.serviceIds === null || addOn.serviceIds.includes(serviceId));
}

/**
 * What the sitting costs and how long it takes, as the price list says.
 *
 * Per service and never below zero for one: an add-on that shortens the nails
 * can make that service free, not pay for the pedicure beside it. The same
 * floor the server applies when it spreads such a reduction over the service's
 * own lines.
 */
export function selectionTotals(
  lines: readonly ServiceLine[],
  services: readonly PickerService[],
  addOns: readonly PickerAddOn[],
): { priceMinor: number; durationMinutes: number } {
  let priceMinor = 0;
  let durationMinutes = 0;
  for (const line of lines) {
    const service = services.find((item) => item.id === line.serviceId);
    if (!service) continue;
    const chosen = addOnsFor(line.serviceId, addOns).filter((addOn) => line.addOnIds.includes(addOn.id));
    priceMinor += Math.max(
      0,
      (service.priceMinor ?? 0) + chosen.reduce((total, addOn) => total + (addOn.priceDeltaMinor ?? 0), 0),
    );
    durationMinutes +=
      (service.durationMinutes ?? 0) +
      chosen.reduce((total, addOn) => total + (addOn.durationDeltaMinutes ?? 0), 0);
  }
  return { priceMinor, durationMinutes };
}

/** The first service not already in the sitting, or null when every one is. */
export function nextServiceId(lines: readonly ServiceLine[], services: readonly PickerService[]): string | null {
  return services.find((service) => !lines.some((line) => line.serviceId === service.id))?.id ?? null;
}

/** The body both endpoints take: `services`, each with its own add-ons. */
export function toServicesPayload(lines: readonly ServiceLine[]) {
  return lines.map((line) => ({ service_id: line.serviceId, add_on_ids: [...line.addOnIds] }));
}

export function ServiceLinesField({
  idPrefix,
  lines,
  services,
  addOns,
  addOnsLegend,
  locale,
  onChange,
}: {
  idPrefix: string;
  lines: readonly ServiceLine[];
  services: readonly PickerService[];
  addOns: readonly PickerAddOn[];
  addOnsLegend: string;
  locale: AppLocale;
  onChange: (lines: ServiceLine[]) => void;
}) {
  const t = getTranslator(locale);
  const next = nextServiceId(lines, services);

  const replace = (index: number, line: ServiceLine) =>
    onChange(lines.map((current, position) => (position === index ? line : current)));

  return (
    <div className="service-lines">
      {lines.map((line, index) => {
        const offered = addOnsFor(line.serviceId, addOns);
        const number = index + 1;
        const label = lines.length > 1 ? t("serviceLines.serviceN", { n: number }) : t("services.service");
        return (
          <div className="service-line" key={`${index}:${line.serviceId}`}>
            <div className="service-line-head">
              <label htmlFor={`${idPrefix}-service-${index}`}>
                {label}
                <select
                  id={`${idPrefix}-service-${index}`}
                  value={line.serviceId}
                  required
                  onChange={(event) => replace(index, { serviceId: event.target.value, addOnIds: [] })}
                >
                  {/* A service already in the sitting is not offered twice. */}
                  {services
                    .filter(
                      (service) =>
                        service.id === line.serviceId || !lines.some((other) => other.serviceId === service.id),
                    )
                    .map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                </select>
              </label>
              {lines.length > 1 && (
                <button
                  className="inline-action"
                  type="button"
                  aria-label={t("serviceLines.removeN", { n: number })}
                  onClick={() => onChange(lines.filter((_, position) => position !== index))}
                >
                  {t("serviceLines.remove")}
                </button>
              )}
            </div>
            {offered.length > 0 && (
              <fieldset className="checkbox-set">
                <legend>{lines.length > 1 ? `${addOnsLegend} · ${label}` : addOnsLegend}</legend>
                {offered.map((addOn) => (
                  <label key={addOn.id} className="radio-row">
                    <input
                      type="checkbox"
                      checked={line.addOnIds.includes(addOn.id)}
                      onChange={(event) =>
                        replace(index, {
                          serviceId: line.serviceId,
                          addOnIds: event.target.checked
                            ? [...line.addOnIds, addOn.id]
                            : line.addOnIds.filter((value) => value !== addOn.id),
                        })
                      }
                    />{" "}
                    {addOn.name}
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        );
      })}
      {next !== null && lines.length < MAX_SERVICES && (
        <button
          className="secondary-button service-lines-add"
          type="button"
          onClick={() => onChange([...lines, { serviceId: next, addOnIds: [] }])}
        >
          {t("serviceLines.add")}
        </button>
      )}
    </div>
  );
}
