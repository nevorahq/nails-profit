"use client";

import { useCallback, useState } from "react";

import { NavIcon } from "@/components/icons";
import { DatePickerDialog } from "@/components/date-picker-dialog";

/**
 * «Ещё»: the last tile of the day strip, for any day the strip does not show.
 *
 * Two weeks of tiles cover most appointments, and a studio books ninety days
 * ahead and writes up yesterday's work, so some day is always out of reach of
 * the strip. A date field under it spent a whole row on that; this is the same
 * field behind a tile as narrow as can be. The tile opens the project's own
 * month, in the middle of the screen (`date-picker-dialog.tsx`), and the day
 * chosen then stands in the strip, lit, like any other.
 *
 * The input stays in the form — it is what `FormData` reads the date from — and
 * is kept in step with the choice; nothing here shows it.
 */
export function DayMoreTile({
  label,
  fieldLabel,
  value,
  today,
  localeTag,
  labels,
  onChange,
}: {
  /** The tile's word, «Ещё». */
  label: string;
  /** What a screen reader calls the date field. */
  fieldLabel: string;
  value: string;
  today: string;
  localeTag: string;
  labels: Readonly<{ title: string; today: string; close: string; previous: string; next: string }>;
  onChange: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Stable, because the window re-binds its keys whenever this changes.
  const close = useCallback(() => setOpen(false), []);

  return (
    <span className="day-more">
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span aria-hidden="true">
          <NavIcon name="calendar" />
        </span>
        <strong>{label}</strong>
      </button>
      <input
        className="day-more-input"
        type="date"
        name="date"
        aria-label={fieldLabel}
        tabIndex={-1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      />
      {open && (
        <DatePickerDialog
          value={value}
          today={today}
          localeTag={localeTag}
          title={labels.title}
          todayLabel={labels.today}
          closeLabel={labels.close}
          previousLabel={labels.previous}
          nextLabel={labels.next}
          onPick={(date) => {
            onChange(date);
            setOpen(false);
          }}
          onClose={close}
        />
      )}
    </span>
  );
}
