"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { openingSetupProblems, type OpeningProblem } from "@/domain/opening-setup";
import { parseLocalTime } from "@/domain/timezone";
import { parseIntegerValue, parseMoneyMinor } from "@/domain/import-values";
import type { AppLocale } from "@/i18n/messages";
import { getErrorMessage } from "@/i18n/messages";
import { type MessageKey } from "@/i18n/t";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
import type { OpeningSetupView } from "@/lib/opening-setup";

type Row = {
  /** The service's id when it already exists, the catalogue key when it would be created. */
  id?: string;
  key?: string;
  name: string;
  checked: boolean;
  price: string;
  duration: string;
};

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_NAMES: Record<number, MessageKey> = {
  1: "weekday.monday",
  2: "weekday.tuesday",
  3: "weekday.wednesday",
  4: "weekday.thursday",
  5: "weekday.friday",
  6: "weekday.saturday",
  7: "weekday.sunday",
};

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * «Ваш прайс и часы»: the one screen between creating a studio and anything a
 * client can see.
 *
 * Everything on it is already filled in — the service registration made, its
 * price and length, the week — because a blank screen is homework and this one
 * should take a glance. What it adds is the glance: until it is saved the page
 * stays shut, and the button that opens it saves first.
 */
export function OpeningSetup({
  view,
  locale,
  currency,
  businessType,
  bookingAvailable,
}: Readonly<{
  view: OpeningSetupView;
  locale: AppLocale;
  currency: string;
  businessType: "solo" | "studio";
  /** The deployment's own switch: with public booking off there is no page to open. */
  bookingAvailable: boolean;
}>) {
  const t = useTranslator(locale);
  const register = useRegister();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => [
    ...view.services.map((service) => ({
      id: service.id,
      name: service.name,
      checked: true,
      price: service.priceMinor !== null ? String(service.priceMinor / 100) : "",
      duration: service.durationMinutes !== null ? String(service.durationMinutes) : "",
    })),
    ...view.catalogue.map((entry) => ({
      key: entry.key,
      name: entry.name,
      checked: false,
      price: "",
      duration: String(entry.durationMinutes),
    })),
  ]);
  const [weekdays, setWeekdays] = useState<number[]>(() => view.week?.weekdays ?? []);
  const [start, setStart] = useState(() => (view.week ? clock(view.week.startMinute) : ""));
  const [end, setEnd] = useState(() => (view.week ? clock(view.week.endMinute) : ""));
  const [problems, setProblems] = useState<OpeningProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const chosen = rows.filter((row) => row.checked);
  const problemFor = (field: string) => problems.find((problem) => problem.field === field);
  const say = (problem: OpeningProblem | undefined) =>
    problem ? t(`openingSetup.problem.${problem.code}` as MessageKey) : null;

  function update(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
    setProblems([]);
  }

  async function save(openBooking: boolean) {
    setError(null);
    const services = chosen.map((row) => ({
      priceMinor: parseMoneyMinor(row.price) ?? 0,
      durationMinutes: parseIntegerValue(row.duration) ?? 0,
    }));
    const week = view.week
      ? { weekdays, startMinute: parseLocalTime(start), endMinute: parseLocalTime(end) }
      : null;
    const found = openingSetupProblems({ services, week });
    setProblems(found);
    if (found.length > 0) return;

    setPending(true);
    const response = await fetch("/api/v1/organizations/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        services: chosen.map((row, index) => ({
          ...(row.id ? { id: row.id } : { key: row.key }),
          price_minor: services[index].priceMinor,
          duration_minutes: services[index].durationMinutes,
        })),
        // Unticking a service that already exists takes it off the price list;
        // nothing is deleted, the archive keeps it for its history.
        archive_service_ids: rows.filter((row) => row.id && !row.checked).map((row) => row.id),
        workweek: week ? { weekdays, start, end } : null,
        open_booking: openBooking,
      }),
    }).catch(() => null);
    if (!response?.ok) {
      const payload = await response?.json().catch(() => null);
      const code = payload?.error?.code;
      setError(code ? getErrorMessage(code, t("openingSetup.failed"), locale, register) : t("openingSetup.failed"));
      setPending(false);
      return;
    }
    router.push("/app");
    router.refresh();
  }

  // The button the registration tick asked for leads; the other stays one tap away.
  const leadsWithOpening = bookingAvailable && view.wantsOnlineBooking;
  const none = problemFor("services");

  return (
    <main className="auth-shell">
      <section className="auth-card workspace-card opening-card">
        <h1>{t("openingSetup.title")}</h1>
        <p className="muted">{t("openingSetup.lead")}</p>

        <fieldset className="checkbox-set opening-services">
          <legend>{t("openingSetup.services")}</legend>
          {rows.map((row, index) => {
            const at = chosen.indexOf(row);
            const price = at >= 0 ? say(problemFor(`services.${at}.price_minor`)) : null;
            const duration = at >= 0 ? say(problemFor(`services.${at}.duration_minutes`)) : null;
            return (
              <div className={`opening-service${row.checked ? " is-checked" : ""}`} key={row.id ?? row.key}>
                <label className="radio-row">
                  <input
                    type="checkbox"
                    checked={row.checked}
                    disabled={pending}
                    onChange={(event) => update(index, { checked: event.target.checked })}
                  />
                  <span>{row.name}</span>
                </label>
                {row.checked && (
                  <div className="opening-service-fields">
                    <label>
                      {t("openingSetup.price", { currency })}
                      <input
                        inputMode="decimal"
                        value={row.price}
                        disabled={pending}
                        aria-invalid={price ? true : undefined}
                        onChange={(event) => update(index, { price: event.target.value })}
                      />
                      {price && <span className="field-error">{price}</span>}
                    </label>
                    <label>
                      {t("openingSetup.duration")}
                      <input
                        inputMode="numeric"
                        value={row.duration}
                        disabled={pending}
                        aria-invalid={duration ? true : undefined}
                        onChange={(event) => update(index, { duration: event.target.value })}
                      />
                      {duration && <span className="field-error">{duration}</span>}
                    </label>
                  </div>
                )}
              </div>
            );
          })}
          {none && <p className="form-error" role="alert">{say(none)}</p>}
        </fieldset>

        {view.week && (
          <fieldset className="checkbox-set opening-hours">
            <legend>{t("openingSetup.hours")}</legend>
            {businessType === "studio" && <p className="field-hint">{t("openingSetup.hoursStudio")}</p>}
            <div className="opening-days">
              {DAYS.map((day) => {
                const on = weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`chip${on ? " is-on" : ""}`}
                    aria-pressed={on}
                    aria-label={t(DAY_NAMES[day])}
                    disabled={pending}
                    onClick={() => {
                      setWeekdays((current) =>
                        on ? current.filter((other) => other !== day) : [...current, day].sort((a, b) => a - b),
                      );
                      setProblems([]);
                    }}
                  >
                    {t(`openingSetup.day.${day}` as MessageKey)}
                  </button>
                );
              })}
            </div>
            {say(problemFor("workweek.weekdays")) && (
              <p className="form-error" role="alert">{say(problemFor("workweek.weekdays"))}</p>
            )}
            <div className="opening-times">
              <label>
                {t("openingSetup.from")}
                <input type="time" value={start} disabled={pending} onChange={(event) => { setStart(event.target.value); setProblems([]); }} />
              </label>
              <label>
                {t("openingSetup.to")}
                <input type="time" value={end} disabled={pending} onChange={(event) => { setEnd(event.target.value); setProblems([]); }} />
              </label>
            </div>
            {say(problemFor("workweek.hours")) && (
              <p className="form-error" role="alert">{say(problemFor("workweek.hours"))}</p>
            )}
          </fieldset>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="opening-actions">
          {bookingAvailable ? (
            <>
              <button
                type="button"
                className={leadsWithOpening ? "primary-button" : "secondary-button"}
                disabled={pending}
                onClick={() => save(true)}
              >
                {t("openingSetup.saveAndOpen")}
              </button>
              <button
                type="button"
                className={leadsWithOpening ? "secondary-button" : "primary-button"}
                disabled={pending}
                onClick={() => save(false)}
              >
                {t("openingSetup.saveLater")}
              </button>
            </>
          ) : (
            <button type="button" className="primary-button" disabled={pending} onClick={() => save(false)}>
              {t("openingSetup.save")}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
