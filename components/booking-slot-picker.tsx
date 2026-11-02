"use client";

import { useEffect, useState } from "react";

import { slotTimes } from "@/components/booking-slots";
import { useTranslator } from "@/components/lexicon-provider";
import type { AppLocale } from "@/i18n/messages";

/** What the last request for `url` came back with. */
type Answer = Readonly<{ url: string; times: readonly string[] | null }>;

/**
 * The free times of the chosen day, as buttons.
 *
 * It only asks and shows. Choosing one hands the time back through `onPick`,
 * and the form's own time field stays the single place the value lives — so a
 * time typed by hand, which the desk is allowed (the server takes any time that
 * does not collide), and a time tapped here are the same thing to the form.
 *
 * `url` is null while there is nothing to ask. A new url abandons the request
 * in flight: changing the date twice quickly must not let the first answer land
 * on top of the second.
 */
export function BookingSlotPicker({
  url,
  value,
  onPick,
  locale,
}: {
  url: string | null;
  value: string;
  onPick: (time: string) => void;
  locale: AppLocale;
}) {
  const t = useTranslator(locale);
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (!url) return;

    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { data: { timezone: string; slots: string[] } };
        setAnswer({ url, times: slotTimes(body.data.slots, body.data.timezone) });
      })
      .catch((failure: unknown) => {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        setAnswer({ url, times: null });
      });

    return () => controller.abort();
  }, [url]);

  // An answer to an earlier url is not an answer to this one: until the new one
  // lands the picker is loading, rather than showing the previous day's times.
  if (!url) return null;
  const current = answer?.url === url ? answer : null;
  const times = current?.times ?? [];

  return (
    <fieldset className="slot-picker">
      <legend>{t("calendar.freeSlots")}</legend>
      {current === null && (
        <p className="muted" role="status">
          {t("calendar.slotsLoading")}
        </p>
      )}
      {current !== null && current.times === null && <p className="muted">{t("calendar.slotsFailed")}</p>}
      {current?.times && times.length === 0 && <p className="muted">{t("calendar.noFreeSlots")}</p>}
      {times.length > 0 && (
        <div className="slot-picker-list">
          {times.map((time) => (
            <button
              key={time}
              type="button"
              className={`slot-chip${value === time ? " is-on" : ""}`}
              aria-pressed={value === time}
              onClick={() => onPick(time)}
            >
              {time}
            </button>
          ))}
        </div>
      )}
    </fieldset>
  );
}
