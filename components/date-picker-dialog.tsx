"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A month to pick a day from, in a window of its own in the middle of the screen.
 *
 * The browser's own date picker is what «Ещё» used to open, and it is not ours to
 * dress: it comes out of the corner of the field in the system's colours and
 * shape, and on a phone as a wheel of a different family from everything else
 * here. This one is the project's — the same dim and card as the appointment
 * window, the month grid's round days, the green for the chosen one — and sits
 * in the middle however large the screen.
 *
 * It picks and reports; the form's date field, hidden behind the tile, is still
 * what the form reads. Any day may be chosen, a past one too: the desk writes up
 * yesterday's work. Weeks start on Monday, as the calendar page's do.
 */

type View = Readonly<{ year: number; month: number }>;

const pad = (value: number) => String(value).padStart(2, "0");
const isoOf = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

function partsOf(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

export function DatePickerDialog({
  value,
  today,
  localeTag,
  title,
  todayLabel,
  closeLabel,
  previousLabel,
  nextLabel,
  onPick,
  onClose,
}: {
  /** The chosen ISO date; the month opens on it. */
  value: string;
  today: string;
  localeTag: string;
  title: string;
  todayLabel: string;
  closeLabel: string;
  previousLabel: string;
  nextLabel: string;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const start = partsOf(value) ?? partsOf(today) ?? { year: 1970, month: 1, day: 1 };
  const [view, setView] = useState<View>({ year: start.year, month: start.month });
  const card = useRef<HTMLDivElement>(null);

  // Focus goes in on opening and back to what had it on closing, and Escape closes
  // this window and not the appointment window under it, which listens for the
  // same key on the document: the capture phase gets there first.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const target =
      card.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
      card.current?.querySelector<HTMLElement>("[data-today]") ??
      card.current;
    target?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab" && card.current) {
        const stops = [...card.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      before?.focus({ preventScroll: true });
    };
  }, [onClose]);

  const daysInMonth = new Date(Date.UTC(view.year, view.month, 0)).getUTCDate();
  // Monday is the first column.
  const lead = (new Date(Date.UTC(view.year, view.month - 1, 1)).getUTCDay() + 6) % 7;
  const monthName = new Intl.DateTimeFormat(localeTag, { timeZone: "UTC", month: "long", year: "numeric" }).format(
    new Date(Date.UTC(view.year, view.month - 1, 1, 12)),
  );
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(localeTag, { timeZone: "UTC", weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + index, 12))),
  );
  const move = (step: number) =>
    setView((current) => {
      const moved = new Date(Date.UTC(current.year, current.month - 1 + step, 1));
      return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1 };
    });

  return createPortal(
    <div
      className="date-picker-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="date-picker" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={card}>
        <div className="date-picker-head">
          <button type="button" className="date-picker-step" aria-label={previousLabel} onClick={() => move(-1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <strong aria-live="polite">{monthName}</strong>
          <button type="button" className="date-picker-step" aria-label={nextLabel} onClick={() => move(1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        <div className="date-picker-week" aria-hidden="true">
          {weekdays.map((name) => (
            <span key={name}>{name}</span>
          ))}
        </div>
        <div className="date-picker-days">
          {Array.from({ length: lead }, (_, index) => (
            <span key={`blank-${index}`} aria-hidden="true" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const day = index + 1;
            const date = isoOf(view.year, view.month, day);
            const stamp = new Date(Date.UTC(view.year, view.month - 1, day, 12));
            return (
              <button
                key={date}
                type="button"
                data-date={date}
                data-today={date === today ? "true" : undefined}
                aria-pressed={date === value}
                aria-label={new Intl.DateTimeFormat(localeTag, { timeZone: "UTC", dateStyle: "full" }).format(stamp)}
                onClick={() => onPick(date)}
              >
                {day}
              </button>
            );
          })}
        </div>
        <div className="date-picker-foot">
          <button type="button" onClick={() => onPick(today)}>
            {todayLabel}
          </button>
          <button type="button" onClick={onClose}>
            {closeLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
