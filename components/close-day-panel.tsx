"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";
import type { UnclosedBooking } from "@/lib/unclosed-bookings";

/**
 * «Закройте прошедшие записи» — the appointments that happened and are in no
 * report yet, with the two answers that cover nearly all of them one tap away.
 *
 * «Состоялась» closes at the booking's own «Итого», the same request the
 * calendar's «Завершить в визит» makes; «Неявка» is the calendar's no-show.
 * Anything else — a different amount, a different length — is the calendar
 * card, which already asks for both, so the third choice is a link to it.
 */
export function CloseDayPanel({
  items,
  count,
  totalMinor,
  currency,
  locale,
  showSpecialist,
}: {
  items: readonly UnclosedBooking[];
  count: number;
  totalMinor: number;
  currency: string;
  locale: AppLocale;
  /** Whose appointment it was, when there is more than one person it could be. */
  showSpecialist: boolean;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeTag(locale));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(booking: UnclosedBooking, action: "complete" | "no-show") {
    setPendingId(booking.id);
    setError(null);
    const response = await fetch(`/api/v1/bookings/${booking.id}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // One key per press: a double tap is the same decision, not two.
        ...(action === "complete" ? { "idempotency-key": `close-day-${booking.id}-${booking.version}` } : {}),
      },
      body: JSON.stringify({ version: booking.version }),
    });
    setPendingId(null);
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as {
        error?: { code: string; message: string };
      } | null;
      setError(
        failure?.error
          ? getErrorMessage(failure.error.code, failure.error.message, locale, register)
          : t("closeVisit.saveFailed"),
      );
      return;
    }
    router.refresh();
  }

  return (
    <section className="panel close-day-panel" id="close-day" aria-labelledby="close-day-title">
      <h2 id="close-day-title">{t("closeDay.title")}</h2>
      <p className="muted">{t("closeDay.lead", { count, amount: money(totalMinor) })}</p>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <ul className="close-day-list">
        {items.map((booking) => (
          <li key={booking.id} className="close-day-item">
            <div className="close-day-what">
              <strong>{booking.clientName ?? t("calendar.noClient")}</strong>
              <small>
                {[booking.serviceName, showSpecialist ? booking.specialistName : null]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
              <small>{`${booking.localDate} · ${booking.localTime}`}</small>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="primary-button"
                disabled={pendingId !== null}
                onClick={() => act(booking, "complete")}
              >
                {t("closeDay.came", { amount: money(booking.priceMinor) })}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={pendingId !== null}
                onClick={() => act(booking, "no-show")}
              >
                {t("calendar.noShow")}
              </button>
              <Link
                className="text-link"
                href={`/app/calendar?date=${booking.localDate}&specialist=${booking.specialistId}&booking=${booking.id}`}
              >
                {t("closeDay.other")}
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {count > items.length && (
        <p className="muted">
          {t("closeDay.more", { count: count - items.length })}{" "}
          <Link className="text-link" href="/app/calendar">
            {t("nav.calendar")}
          </Link>
        </p>
      )}
    </section>
  );
}
