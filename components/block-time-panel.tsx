"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { localToUtc, parseLocalDate, parseLocalTime, resolveLocal } from "@/domain/timezone";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";

/**
 * «Заблокировать время»: an interval in which one master cannot be booked.
 *
 * It lives beside the working hours because it is the same kind of statement —
 * a lunch, a course or a holiday is an exception *to the rota*, and the rota is
 * what this page edits. On the calendar it was a collapsed panel at the foot of
 * the day, which is a place for things done to a day's appointments, not for
 * changing who is available. The blocked hours still show on the calendar, as
 * taken time with their own «Разблокировать»: the list of the day has to say
 * that an hour is spoken for, wherever the hour was spoken for.
 *
 * Times are typed as wall clock at the address and are turned into instants
 * here with the address's own zone, the same functions the availability engine
 * uses. Reading them in the browser's zone would move a Chișinău lunch to
 * wherever the laptop is.
 */
export function BlockTimePanel({
  locations,
  specialists,
  today,
  locale,
}: {
  locations: readonly Readonly<{ id: string; name: string; timezone: string }>[];
  /** Already narrowed to the people this caller may block: a master gets only themselves. */
  specialists: readonly Readonly<{ id: string; name: string }>[];
  /** The date the form opens on. */
  today: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** A wall-clock time at an address, turned into the instant it names. */
  function instantAt(timezone: string, date: string, time: string): Date | "invalid" | "gap" {
    const localDate = parseLocalDate(date);
    const minutes = parseLocalTime(time);
    if (!localDate || minutes === null) return "invalid";

    // A DST gap is a time that does not exist. Silently rounding it forward
    // would block an hour the studio never chose.
    const resolution = resolveLocal(localDate, minutes, timezone);
    if (resolution.kind === "gap") return "gap";
    return localToUtc(localDate, minutes, timezone);
  }

  async function blockTime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const locationId = String(data.get("location_id") ?? "");
    const timezone = locationId
      ? (locations.find((place) => place.id === locationId)?.timezone ?? "UTC")
      : (locations[0]?.timezone ?? "UTC");

    const date = String(data.get("date"));
    const from = instantAt(timezone, date, String(data.get("from")));
    const to = instantAt(timezone, date, String(data.get("to")));
    setDone(false);
    if (from === "invalid" || to === "invalid") return setError(t("bookingSetup.timeInvalid"));
    if (from === "gap" || to === "gap") return setError(t("bookingSetup.timeDoesNotExist"));
    if (to <= from) return setError(t("bookingSetup.blockOrder"));

    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/availability/exceptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specialist_id: String(data.get("specialist_id")),
        ...(locationId ? { location_id: locationId } : {}),
        kind: "unavailable",
        starts_at: from.toISOString(),
        ends_at: to.toISOString(),
      }),
    });
    setPending(false);

    if (response.ok) {
      form.reset();
      setDone(true);
      router.refresh();
      return;
    }

    const failure = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    const code = failure?.error?.code;
    setError(
      code
        ? getErrorMessage(code, failure?.error?.message ?? t("common.saveFailed"), locale, register)
        : t("common.saveFailed"),
    );
  }

  if (specialists.length === 0) return null;

  return (
    <section className="panel booking-panel booking-block-time">
      <h2>{t("bookingSetup.blockTime")}</h2>
      <p className="muted">{t("bookingSetup.blockHint")}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form className="inline-form" onSubmit={blockTime}>
        {/*
          Asked only where there is a choice. A master's list is already
          narrowed to themselves, so for them there never was one.
        */}
        {specialists.length > 1 ? (
          <label>
            {t("bookingSetup.specialist")}
            <select name="specialist_id" required>
              {specialists.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="specialist_id" value={specialists[0]?.id ?? ""} />
        )}
        {/*
          «Все адреса» and the only address are the same block written two ways,
          so with one address there is nothing to ask. The wider of the two is
          what an empty value means, and it is what a studio of one wants.
        */}
        {locations.length > 1 ? (
          <label>
            {t("bookingSetup.location")}
            <select name="location_id" defaultValue="">
              <option value="">{t("bookingSetup.blockEveryLocation")}</option>
              {locations.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="location_id" value="" />
        )}
        <label>
          {t("bookingSetup.blockDate")}
          <input type="date" name="date" defaultValue={today} required />
        </label>
        <label>
          {t("bookingSetup.from")}
          <input type="time" name="from" required />
        </label>
        <label>
          {t("bookingSetup.to")}
          <input type="time" name="to" required />
        </label>
        <button className="secondary-button" type="submit" disabled={pending}>
          {t("bookingSetup.block")}
        </button>
      </form>
      {done && (
        <p className="muted" role="status">
          {t("bookingSetup.blockDone")}
        </p>
      )}
    </section>
  );
}
