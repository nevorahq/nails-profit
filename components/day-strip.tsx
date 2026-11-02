"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A row of days to pick one from, which scrolls sideways when there are more
 * than the width holds.
 *
 * Shared by the public booking page, where a day is disabled while it has no
 * free time, and the calendar's «Новая запись», where the desk may book any day
 * and none is. It draws and reports; what a day's words are (a weekday, «Сегодня»)
 * and whether it can be pressed is the caller's, because only the caller knows
 * what the day has in it.
 */

export type StripDay = Readonly<{
  /** ISO date, `YYYY-MM-DD`: what `onPick` hands back. */
  date: string;
  /** The small line over the date. */
  top: string;
  /** The date itself, in the large line. */
  main: string;
  /** What a screen reader says for this button. */
  label: string;
  disabled?: boolean;
}>;

export function DayStrip({
  days,
  selected,
  onPick,
  trailing,
}: {
  days: readonly StripDay[];
  /** The chosen ISO date, or null while nothing is. */
  selected: string | null;
  onPick: (date: string) => void;
  /** A tile after the days — the calendar's «Ещё», for a day the strip does not show. */
  trailing?: ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const hasTrailing = trailing !== undefined && trailing !== null;

  // With a tile held at the end of the row, the chosen day can be one that the tile
  // stands over: the form opens on the day the calendar showed, which may be the
  // third and not the first. The row is moved just far enough to show it, and not
  // the page, which `scrollIntoView` would also do.
  useEffect(() => {
    const row = strip.current;
    const tile = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!hasTrailing || !row || !tile) return;

    const held = (row.lastElementChild as HTMLElement | null)?.offsetWidth ?? 0;
    const rowBox = row.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    const left = tileBox.left - rowBox.left + row.scrollLeft;
    if (left < row.scrollLeft) row.scrollLeft = left;
    else if (left + tileBox.width > row.scrollLeft + row.clientWidth - held) {
      row.scrollLeft = left + tileBox.width - row.clientWidth + held;
    }
    // Only when the chosen day changes: a row the reader has scrolled by hand is not
    // pulled back by every other change in the form.
  }, [selected, hasTrailing]);

  return (
    <div className="day-strip" ref={strip}>
      {days.map((day) => (
        <button
          key={day.date}
          data-date={day.date}
          type="button"
          className={day.date === selected ? "is-selected" : undefined}
          aria-pressed={day.date === selected}
          aria-label={day.label}
          disabled={day.disabled}
          onClick={() => onPick(day.date)}
        >
          <span>{day.top}</span>
          <strong>{day.main}</strong>
        </button>
      ))}
      {trailing}
    </div>
  );
}
