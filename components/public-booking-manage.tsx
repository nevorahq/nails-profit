"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Currency } from "@/domain/money";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";
import {
  bookingNextStepKey,
  publicBookingErrorKey,
  readApiError,
  retryAfterMinutes,
} from "@/lib/public-booking-ux";

type Status = "pending_confirmation" | "confirmed" | "cancelled" | "completed" | "no_show";
type CancelledBy = "client" | "staff" | "system" | null;
type BookingView = {
  organization_name: string;
  organization_slug: string;
  locale: AppLocale;
  currency: Currency;
  location: { id: string; name: string; address: string | null; timezone: string };
  specialist: { id: string; name: string };
  starts_at: string;
  ends_at: string;
  status: Status;
  cancelled_by: CancelledBy;
  cancellation_reason: string | null;
  confirmation_due_at: string | null;
  version: number;
  price_minor: number;
  service_id: string | null;
  add_on_ids: string[];
  lines: { kind: string; name: string; price_minor: number; duration_minutes: number }[];
};
type Slot = { starts_at: string; ends_at: string; specialist_id: string; specialist_name: string };

/**
 * How often the page asks whether the studio has answered, and how many times
 * it may ask before it stops.
 *
 * The budget is the point. `PUBLIC_BOOKING_POLL_RULE` allows 120 checks an
 * hour from one caller; stopping at 90 means a client who leaves the tab open
 * never meets a 429 — and never gets counted as suspicious for waiting, which
 * is what a refusal would record. What they get instead is a button.
 *
 * Thirty seconds because the answer comes from a person: somebody opens the
 * calendar between clients and confirms. Half a minute is well inside the time
 * it takes them to do that, and slow enough that the whole two hours a request
 * may sit unanswered fits inside the budget.
 */
const POLL_INTERVAL_MS = 30_000;
const POLL_BUDGET = 90;

function todayInZone(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function PublicBookingManage({ token, initial }: { token: string; initial: BookingView }) {
  const [booking, setBooking] = useState(initial);
  const [date, setDate] = useState(() => todayInZone(initial.location.timezone));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const moveKeys = useRef(new Map<string, string>());
  const t = useMemo(() => getTranslator(booking.locale), [booking.locale]);
  const tag = localeTag(booking.locale);
  const active = booking.status === "confirmed" || booking.status === "pending_confirmation";
  const nextStep = bookingNextStepKey({
    status: booking.status,
    cancelledBy: booking.cancelled_by,
    cancellationReason: booking.cancellation_reason,
    hasConfirmationDeadline: booking.confirmation_due_at !== null,
  });

  /**
   * The same reading of a refusal the booking form does. This screen offers
   * fewer ways to fail and used to translate one of them, so a client whose
   * appointment had been moved underneath them, or who had asked too often,
   * was told to "check the details" of a page with no details to check.
   */
  function showApiError(response: Response, body: unknown) {
    const parsed = readApiError(body, response.status);
    setError(t(publicBookingErrorKey(parsed), { minutes: retryAfterMinutes(parsed) }));
    setRequestId(parsed.requestId);
  }

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}`);
    const body = await response.json().catch(() => null);
    if (response.ok) setBooking(body.data);
  }, [token]);

  /**
   * Watching for the studio's answer, so the client does not have to.
   *
   * A request sits in `pending_confirmation` until somebody in the studio opens
   * the calendar, and until now the only thing that told the client it had been
   * answered was an email. That email is the weakest part of the whole flow:
   * it can be queued behind a five-minute cron, filtered as spam, or — for a
   * client the studio typed in at the desk — impossible to send at all, because
   * `client.email` is nullable and often empty.
   *
   * This asks instead. The screen the client is already looking at becomes the
   * channel, and it works for exactly the people email fails.
   *
   * It stops on its own, and every reason it stops matters. A hidden tab does
   * not spend a check, because nobody is reading it. The budget runs out before
   * the rate limiter does (see `POLL_BUDGET`), so a forgotten tab is never
   * refused and never recorded as an abuser. Any refusal at all stops it — a
   * link revoked, a studio rolled back off the public surface, a limit hit
   * anyway — because a page that keeps asking after a "no" is the thing rate
   * limits exist to stop.
   */
  const [watching, setWatching] = useState(true);
  const checksLeft = useRef(POLL_BUDGET);
  const dueAt = booking.confirmation_due_at
    ? new Date(booking.confirmation_due_at).getTime()
    : null;

  const checkStatus = useCallback(async () => {
    const response = await fetch(
      `/api/v1/public/bookings/${encodeURIComponent(token)}/status`,
    );
    if (!response.ok) {
      setWatching(false);
      return;
    }
    const body = await response.json().catch(() => null);
    const seen = body?.data as { status: Status; version: number } | undefined;
    if (!seen) return;
    // The version moves on every change, including one that leaves the status
    // alone — a reschedule by the studio. Both are worth showing.
    if (seen.status !== booking.status || seen.version !== booking.version) {
      await refresh();
      setNotice(t("publicBooking.statusChanged"));
    }
    /*
     * `setWatching` and `setNotice` are listed even though a `useState` setter
     * is stable and the exhaustive-deps rule does not ask for them. The React
     * Compiler does: it infers what the callback closes over and refuses to
     * optimize a component whose written dependencies do not match, which is
     * what `react-hooks/preserve-manual-memoization` reports.
     */
  }, [booking.status, booking.version, refresh, setNotice, setWatching, t, token]);

  useEffect(() => {
    if (booking.status !== "pending_confirmation" || !watching) return;

    const timer = setInterval(() => {
      // Nobody is looking, so nothing needs saying — and a tab left open for a
      // week must not spend its budget while it sits behind other windows.
      if (document.visibilityState !== "visible") return;
      if (dueAt !== null && Date.now() > dueAt) {
        setWatching(false);
        return;
      }
      if (checksLeft.current <= 0) {
        setWatching(false);
        return;
      }
      checksLeft.current -= 1;
      void checkStatus();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [booking.status, checkStatus, dueAt, watching]);

  async function findSlots(event: FormEvent) {
    event.preventDefault();
    if (!booking.service_id) return;
    setPending(true);
    setError(null);
    setRequestId(null);
    setNotice(null);
    const query = new URLSearchParams({
      location_id: booking.location.id,
      service_id: booking.service_id,
      add_on_ids: booking.add_on_ids.join(","),
      specialist_id: "any",
      date,
    });
    const response = await fetch(
      `/api/v1/public/booking/${booking.organization_slug}/availability?${query.toString()}`,
    );
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) return showApiError(response, body);
    setSlots(body.data.slots);
  }

  async function move(slot: Slot) {
    const selection = `${booking.version}:${slot.starts_at}:${slot.specialist_id}`;
    const idempotencyKey = moveKeys.current.get(selection) ?? crypto.randomUUID();
    moveKeys.current.set(selection, idempotencyKey);
    setPending(true);
    setError(null);
    setRequestId(null);
    const response = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        starts_at: slot.starts_at,
        specialist_id: slot.specialist_id,
        version: booking.version,
      }),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      showApiError(response, body);
      return;
    }
    await refresh();
    setSlots([]);
    setNotice(t("publicBooking.movedMessage"));
  }

  async function cancel() {
    setPending(true);
    setError(null);
    setRequestId(null);
    const response = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: booking.version }),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) return showApiError(response, body);
    await refresh();
    setConfirmCancel(false);
    setNotice(t("publicBooking.cancelledMessage"));
  }

  return (
    <main className="public-booking-shell">
      <header className="public-booking-header">
        <span className="brand">{booking.organization_name}</span>
        <span className={`role-badge booking-status-${booking.status}`}>
          {t(`publicBooking.status.${booking.status}`)}
        </span>
      </header>
      <section className="public-booking-intro">
        <span className="eyebrow">Nail Profit OS</span>
        <h1>{t("publicBooking.manageTitle")}</h1>
      </section>
      <section className="public-booking-card booking-manage-card" aria-busy={pending}>
        {/*
          The status in words the client can act on, above the facts rather than
          below them: what happens next is the question they opened the link to
          answer, and the date and price are what they already know.
        */}
        <p className="booking-next-step">
          {t(nextStep, {
            time: booking.confirmation_due_at
              ? new Intl.DateTimeFormat(tag, {
                  timeZone: booking.location.timezone,
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(booking.confirmation_due_at))
              : "",
          })}
        </p>
        <dl className="booking-manage-facts">
          <div><dt>{t("publicBooking.when")}</dt><dd>{new Intl.DateTimeFormat(tag, { timeZone: booking.location.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date(booking.starts_at))}</dd></div>
          <div><dt>{t("publicBooking.service")}</dt><dd>{booking.lines.map((line) => line.name).join(" · ")}</dd></div>
          <div><dt>{t("publicBooking.specialist")}</dt><dd>{booking.specialist.name}</dd></div>
          <div><dt>{t("publicBooking.where")}</dt><dd>{booking.location.name}{booking.location.address ? ` · ${booking.location.address}` : ""}</dd></div>
          <div><dt>{t("publicBooking.total")}</dt><dd>{formatMoneyMinor(booking.price_minor, booking.currency, tag)}</dd></div>
        </dl>

        {notice && <p className="booking-manage-notice" role="status">{notice}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
            {requestId && (
              <span className="error-reference">
                {t("publicBooking.requestId", { id: requestId })}
              </span>
            )}
          </p>
        )}

        {active && booking.service_id && (
          <details className="booking-manage-action">
            <summary>{t("publicBooking.move")}</summary>
            <form className="inline-form" onSubmit={findSlots}>
              <label>{t("publicBooking.newDate")}<input type="date" min={todayInZone(booking.location.timezone)} value={date} onChange={(event) => { setDate(event.target.value); setSlots([]); }} required /></label>
              <button className="secondary-button" type="submit" disabled={pending}>{t("publicBooking.showTimes")}</button>
            </form>
            {slots.length > 0 && <div className="public-booking-slots"><div>{slots.map((slot) => <button key={`${slot.starts_at}:${slot.specialist_id}`} type="button" onClick={() => move(slot)} disabled={pending}><strong>{new Intl.DateTimeFormat(tag, { timeZone: booking.location.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(slot.starts_at))}</strong><span>{slot.specialist_name}</span></button>)}</div></div>}
          </details>
        )}

        {active && (
          <div className="booking-cancel-area">
            {!confirmCancel ? (
              <button className="inline-action" type="button" onClick={() => setConfirmCancel(true)}>{t("publicBooking.cancelBooking")}</button>
            ) : (
              <div className="warning-banner">
                <p>{t("publicBooking.cancelQuestion")}</p>
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={() => setConfirmCancel(false)}>{t("publicBooking.keepBooking")}</button>
                  <button className="danger-button" type="button" onClick={cancel} disabled={pending}>{t("publicBooking.cancelBooking")}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/*
          Why the page is worth leaving open — and, once it has stopped watching,
          the button that does by hand what it was doing on its own. Saying
          nothing here would leave a client staring at a screen with no way to
          tell whether it is still listening.
        */}
        {booking.status === "pending_confirmation" && (
          <p className="booking-watching" role="status">
            {watching ? (
              <span>{t("publicBooking.watching")}</span>
            ) : (
              <>
                <span>{t("publicBooking.watchingStopped")}</span>
                <button
                  className="inline-action"
                  type="button"
                  onClick={() => {
                    checksLeft.current = POLL_BUDGET;
                    setWatching(true);
                    void checkStatus();
                  }}
                >
                  {t("publicBooking.refreshNow")}
                </button>
              </>
            )}
          </p>
        )}

        {/*
          The way back. A cancelled or finished appointment used to end the page
          in a dead end: nothing left to manage, and no link to the studio the
          client had been trying to book with.
        */}
        {!active && (
          <div className="booking-again">
            <a className="secondary-button" href={`/book/${booking.organization_slug}`}>
              {t("publicBooking.bookAgain")}
            </a>
          </div>
        )}
      </section>
    </main>
  );
}
