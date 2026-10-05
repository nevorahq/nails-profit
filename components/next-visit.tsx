"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import type { MessageKey } from "@/i18n/t";
import { formatLongDate } from "@/lib/format";

/** The intervals the desk is offered: the rhythms a nail studio actually runs on. */
const INTERVALS = [2, 3, 4] as const;

type Suggestion = Readonly<{
  location_id: string;
  specialist_id: string;
  client_id: string;
  services: readonly Readonly<{ service_id: string; add_on_ids: readonly string[] }>[];
  timezone: string;
  days: readonly Readonly<{ date: string; slots: readonly string[] }>[];
  upcoming_starts_at: string | null;
}>;

/**
 * «Следующая запись» under a closed appointment, roadmap phase 8.
 *
 * The client is still at the desk when the visit is closed, and «через три
 * недели?» is answered there or not at all. So the question is put as the three
 * answers a studio gives, each one a tap that turns into the nearest free times
 * of the same master for the same sitting, and one more tap books it.
 *
 * The booking goes through `POST /api/v1/bookings` like any other taken by
 * staff — confirmed, written to the client, put in the master's day — naming
 * the appointment it follows, which is what the return rate counts.
 */
export function NextVisit({
  bookingId,
  locale,
  localeTag,
}: {
  bookingId: string;
  locale: AppLocale;
  localeTag: string;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const [weeks, setWeeks] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | "loading" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);
  // One key per slot, kept across retries: a double tap is one appointment.
  const keys = useRef(new Map<string, string>());

  const when = (instant: string, timezone: string) =>
    formatLongDate(new Date(instant), localeTag, { timeZone: timezone, time: true });
  const clock = (instant: string, timezone: string) =>
    new Intl.DateTimeFormat(localeTag, {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(instant));

  async function look(interval: number) {
    setWeeks(interval);
    setSuggestion("loading");
    setError(null);
    const response = await fetch(`/api/v1/bookings/${bookingId}/next-slots?weeks=${interval}`);
    const body = (await response.json().catch(() => null)) as {
      data?: Suggestion;
      error?: { code: string; message: string };
    } | null;
    if (!response.ok || !body?.data) {
      setSuggestion(null);
      setError(
        body?.error
          ? getErrorMessage(body.error.code, body.error.message, locale, register)
          : t("nextVisit.failed"),
      );
      return;
    }
    setSuggestion(body.data);
  }

  async function book(found: Suggestion, startsAt: string) {
    let key = keys.current.get(startsAt);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(startsAt, key);
    }
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        location_id: found.location_id,
        specialist_id: found.specialist_id,
        client_id: found.client_id,
        services: found.services,
        starts_at: startsAt,
        rebooked_from_booking_id: bookingId,
      }),
    });
    setPending(false);
    if (response.ok) {
      setBooked(when(startsAt, found.timezone));
      setSuggestion(null);
      router.refresh();
      return;
    }
    const failure = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    setError(
      failure?.error
        ? getErrorMessage(failure.error.code, failure.error.message, locale, register)
        : t("common.saveFailed"),
    );
    // Lost to somebody faster: the times on screen are stale, so they are
    // asked for again rather than left to be tapped into a second refusal.
    if (failure?.error?.code === "SLOT_UNAVAILABLE" && weeks !== null) await look(weeks);
  }

  if (booked) {
    return (
      <section className="next-visit" aria-label={t("nextVisit.title")}>
        <p className="booking-manage-notice" role="status">
          {t("nextVisit.booked", { when: booked })}
        </p>
      </section>
    );
  }

  return (
    <section className="next-visit" aria-label={t("nextVisit.title")}>
      <h3>{t("nextVisit.title")}</h3>
      <p className="muted">{t("nextVisit.hint")}</p>
      <div className="next-visit-intervals">
        {INTERVALS.map((interval) => (
          <button
            key={interval}
            type="button"
            className="secondary-button"
            aria-pressed={weeks === interval}
            disabled={pending}
            onClick={() => look(interval)}
          >
            {t(`nextVisit.weeks${interval}` as MessageKey)}
          </button>
        ))}
      </div>

      {suggestion === "loading" && <p className="muted">{t("nextVisit.loading")}</p>}

      {suggestion && suggestion !== "loading" && (
        <>
          {suggestion.upcoming_starts_at && (
            <p className="warning-banner">
              {t("nextVisit.upcoming", { when: when(suggestion.upcoming_starts_at, suggestion.timezone) })}
            </p>
          )}
          {suggestion.days.length === 0 ? (
            <p className="muted">{t("nextVisit.none")}</p>
          ) : (
            suggestion.days.map((day) => (
              <div key={day.date} className="next-visit-day">
                <p>{formatLongDate(new Date(day.slots[0]), localeTag, { timeZone: suggestion.timezone })}</p>
                <div className="next-visit-slots">
                  {day.slots.map((slot) => (
                    <button
                      key={slot}
                      type="button"
                      className="secondary-button"
                      disabled={pending}
                      onClick={() => book(suggestion, slot)}
                    >
                      {clock(slot, suggestion.timezone)}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </>
      )}

      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
