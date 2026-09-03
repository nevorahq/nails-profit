"use client";

import { FormEvent, useMemo, useRef, useState } from "react";

import type { Currency } from "@/domain/money";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";
import {
  publicBookingErrorKey,
  readApiError,
  retryAfterMinutes,
} from "@/lib/public-booking-ux";

type Status = "pending_confirmation" | "confirmed" | "cancelled" | "completed" | "no_show";
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
  version: number;
  price_minor: number;
  service_id: string | null;
  add_on_ids: string[];
  lines: { kind: string; name: string; price_minor: number; duration_minutes: number }[];
};
type Slot = { starts_at: string; ends_at: string; specialist_id: string; specialist_name: string };

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

  async function refresh() {
    const response = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}`);
    const body = await response.json().catch(() => null);
    if (response.ok) setBooking(body.data);
  }

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
      </section>
    </main>
  );
}
