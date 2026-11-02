"use client";

import { useState } from "react";

import { MAX_SERVICES } from "@/domain/service-limit";
import type { AppLocale } from "@/i18n/messages";
import { useTranslator } from "@/components/lexicon-provider";
import {
  addOnsFor,
  selectionTotals,
  type PickerAddOn,
  type PickerService,
  type ServiceLine,
} from "@/components/service-lines-field";

/**
 * What the appointment is made of, as rows to tick.
 *
 * The calendar's «Новая запись» used a select per service and a «+ ещё услуга»
 * to open the next one: three taps for a second service, and no price or length
 * in sight. This is the public page's idea in the desk's size — every service of
 * this master on screen at once, one tap to take it, its add-ons under it once
 * it is taken, and what the sitting comes to at the foot — as a row rather than
 * a card, because a phone has a form's worth of fields to carry beyond this one.
 *
 * A long price list does not push the rest of the form off the screen: past
 * `COLLAPSE_FROM` services only the chosen ones and a button to the rest are
 * shown. The order of `lines` is the order they were ticked, which is the order
 * the appointment will list them in.
 */

/** A price list longer than this is folded behind «Все услуги». */
const COLLAPSE_FROM = 6;

export function ServiceRows({
  lines,
  services,
  addOns,
  addOnsLegend,
  locale,
  formatPrice,
  onChange,
}: {
  lines: readonly ServiceLine[];
  services: readonly PickerService[];
  addOns: readonly PickerAddOn[];
  addOnsLegend: string;
  locale: AppLocale;
  /** Money in the studio's currency and the reader's language. */
  formatPrice: (minor: number) => string;
  onChange: (lines: ServiceLine[]) => void;
}) {
  const t = useTranslator(locale);
  const [expanded, setExpanded] = useState(false);

  /** «1 ч 30 мин»: a length, in the interface's language. */
  const minutesText = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return [
      hours > 0 ? t("publicBooking.hoursShort", { count: hours }) : "",
      rest > 0 || hours === 0 ? t("publicBooking.minutes", { count: rest }) : "",
    ]
      .filter(Boolean)
      .join(" ");
  };

  const folded = services.length > COLLAPSE_FROM && !expanded;
  const shown = folded
    ? services.filter((service) => lines.some((line) => line.serviceId === service.id))
    : services;
  const totals = selectionTotals(lines, services, addOns);

  return (
    <fieldset className="service-rows">
      <legend>{t("calendar.servicesHeading")}</legend>
      {shown.map((service) => {
        const line = lines.find((entry) => entry.serviceId === service.id);
        const picked = line !== undefined;
        // The studio's own limit, which is larger than the public page's: here it is
        // somebody who knows the client deciding.
        const full = !picked && lines.length >= MAX_SERVICES;
        const extras = addOnsFor(service.id, addOns);
        const facts = [
          service.durationMinutes ? minutesText(service.durationMinutes) : null,
          service.priceMinor !== undefined ? formatPrice(service.priceMinor) : null,
        ].filter(Boolean);
        return (
          <div
            key={service.id}
            className="service-row"
            data-picked={picked ? "true" : undefined}
            data-full={full ? "true" : undefined}
          >
            <label>
              <input
                type="checkbox"
                checked={picked}
                disabled={full}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...lines, { serviceId: service.id, addOnIds: [] }]
                      : lines.filter((entry) => entry.serviceId !== service.id),
                  )
                }
              />
              <span className="service-row-name">{service.name}</span>
              {facts.length > 0 && <small>{facts.join(" · ")}</small>}
            </label>
            {line && extras.length > 0 && (
              <fieldset className="service-row-options">
                <legend>{`${addOnsLegend} · ${service.name}`}</legend>
                {extras.map((addOn) => (
                  <label key={addOn.id}>
                    <input
                      type="checkbox"
                      checked={line.addOnIds.includes(addOn.id)}
                      onChange={(event) =>
                        onChange(
                          lines.map((entry) =>
                            entry.serviceId === service.id
                              ? {
                                  serviceId: entry.serviceId,
                                  addOnIds: event.target.checked
                                    ? [...entry.addOnIds, addOn.id]
                                    : entry.addOnIds.filter((id) => id !== addOn.id),
                                }
                              : entry,
                          ),
                        )
                      }
                    />
                    <span>{addOn.name}</span>
                    {addOn.priceDeltaMinor ? <small>{formatPrice(addOn.priceDeltaMinor)}</small> : null}
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        );
      })}
      {services.length > COLLAPSE_FROM && (
        <button type="button" className="service-rows-more" onClick={() => setExpanded((open) => !open)}>
          {expanded ? t("calendar.servicesFewer") : t("calendar.servicesAll", { count: services.length })}
        </button>
      )}
      {lines.length > 0 && (
        <p className="service-rows-total" aria-live="polite">
          <span>{t("publicBooking.total")}</span>
          <strong>{formatPrice(totals.priceMinor)}</strong>
          <span>{minutesText(totals.durationMinutes)}</span>
        </p>
      )}
    </fieldset>
  );
}
