"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import type { MessageKey } from "@/i18n/t";

type Move = Readonly<{
  booking_id: string;
  version: number;
  from: Readonly<{ starts_at: string; ends_at: string }>;
  to: Readonly<{ starts_at: string; ends_at: string }>;
}>;

type Refusal = "too_early" | "outside_working_hours" | "nothing_to_move";

/** The most the desk can shift in one go; the route refuses more. */
const MAX_MINUTES = 240;

/**
 * «Сдвинуть следующие записи» on the card of a visit that ran short or long.
 *
 * Two steps, and the second cannot happen without the first: «Показать» asks
 * what would move and writes nothing, «Сдвинуть» sends back the versions that
 * were shown, so a day that changed in between is refused instead of being
 * rearranged under somebody who was looking at the old one.
 *
 * The direction is a choice of its own rather than a sign in a number field:
 * a minus is the thing a hurried hand leaves out, and the cost is a client told
 * to come an hour later than they agreed.
 */
export function ShiftFollowing({
  bookingId,
  timezone,
  locale,
  localeTag,
  names,
  suggestedEarlierMinutes = 0,
}: {
  bookingId: string;
  timezone: string;
  locale: AppLocale;
  localeTag: string;
  /** Booking id → whom it is for, for the lines of the preview. */
  names: Readonly<Record<string, string>>;
  /** What this visit's actual length freed, when it was closed with one. */
  suggestedEarlierMinutes?: number;
}) {
  const t = useTranslator(locale);
  const register = useRegister();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"earlier" | "later">(suggestedEarlierMinutes > 0 ? "earlier" : "later");
  const [minutes, setMinutes] = useState(suggestedEarlierMinutes > 0 ? String(suggestedEarlierMinutes) : "15");
  const [moves, setMoves] = useState<readonly Move[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const amount = Number.parseInt(minutes, 10);
  const valid = Number.isInteger(amount) && amount > 0 && amount <= MAX_MINUTES;
  const delta = direction === "earlier" ? -amount : amount;

  const hours = (value: string) =>
    new Intl.DateTimeFormat(localeTag, { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(
      new Date(value),
    );

  function reset() {
    setMoves(null);
    setError(null);
    setDone(null);
  }

  async function call(mode: "preview" | "apply") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/bookings/${bookingId}/shift-following`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delta_minutes: delta,
          mode,
          ...(mode === "apply" && moves
            ? { versions: Object.fromEntries(moves.map((move) => [move.booking_id, move.version])) }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: { moves: Move[] };
        error?: { code: string; message: string; details?: { reason?: Refusal } };
      } | null;

      if (response.ok && body?.data) {
        if (mode === "preview") {
          setMoves(body.data.moves);
        } else {
          setMoves(null);
          setDone(body.data.moves.length);
          router.refresh();
        }
        return;
      }

      setMoves(null);
      const reason = body?.error?.details?.reason;
      setError(
        reason
          ? t(`shift.refused.${reason}` as MessageKey)
          : body?.error
            ? getErrorMessage(body.error.code, body.error.message, locale, register)
            : t("common.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="calendar-subform shift-following"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("shift.summary")}</summary>
      <p className="muted">{t("shift.hint")}</p>

      <div className="inline-form">
        <fieldset className="shift-direction">
          <legend>{t("shift.direction")}</legend>
          {(["earlier", "later"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`shift-direction-${bookingId}`}
                checked={direction === value}
                onChange={() => {
                  setDirection(value);
                  reset();
                }}
              />
              {t(value === "earlier" ? "shift.earlier" : "shift.later")}
            </label>
          ))}
        </fieldset>

        <label>
          {t("shift.minutes")}
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_MINUTES}
            step={5}
            value={minutes}
            onChange={(event) => {
              setMinutes(event.target.value);
              reset();
            }}
          />
        </label>

        <button
          type="button"
          className="secondary-button"
          disabled={busy || !valid}
          onClick={() => void call("preview")}
        >
          {busy && moves === null ? t("common.saving") : t("shift.show")}
        </button>
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {done !== null && (
        <p className="muted" role="status">
          {t("shift.done", { count: done })}
        </p>
      )}

      {moves && (
        <div className="shift-preview">
          <h3>{t("shift.willMove")}</h3>
          <ul>
            {moves.map((move) => (
              <li key={move.booking_id}>
                <strong>{names[move.booking_id] ?? t("shift.someone")}</strong>
                <span>
                  {hours(move.from.starts_at)} → {hours(move.to.starts_at)}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">{t("shift.willNotify")}</p>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void call("apply")}>
            {busy ? t("common.saving") : t("shift.apply", { count: moves.length })}
          </button>
        </div>
      )}
    </details>
  );
}
