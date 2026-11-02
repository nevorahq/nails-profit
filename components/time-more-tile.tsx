"use client";

import { useRef } from "react";

/**
 * «Другое»: the way to a time the grid of free times does not offer.
 *
 * The desk may book any time that does not collide with another appointment —
 * 14:20 when the grid runs on the hour, or any time at all in a studio that has
 * no rota filled in and so no free times to show. The form kept a time field
 * for that, under the grid, a whole row for what is the exception. This is the
 * same field behind the last chip of the grid, which looks like one and opens the
 * picker. The time chosen stands in the grid, lit.
 *
 * The form reads the time from its own hidden field; this one only asks.
 */
export function TimeMoreTile({
  label,
  fieldLabel,
  value,
  onChange,
}: {
  label: string;
  /** What a screen reader calls the time field. */
  fieldLabel: string;
  value: string;
  onChange: (time: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  function open() {
    const field = input.current;
    if (!field) return;
    if (typeof field.showPicker === "function") {
      try {
        field.showPicker();
        return;
      } catch {
        // Refused outside a tap, or inside a frame: fall through to focus.
      }
    }
    field.focus();
    field.click();
  }

  return (
    <span className="time-more">
      <button type="button" className="slot-chip" onClick={open}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        {label}
      </button>
      <input
        ref={input}
        className="time-more-input"
        type="time"
        aria-label={fieldLabel}
        tabIndex={-1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}
