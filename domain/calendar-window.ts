import {
  addLocalDays,
  formatLocalDate,
  localDateWeekday,
  parseLocalDate,
  toZonedParts,
  type LocalDate,
} from "@/domain/timezone";

/**
 * The whole ISO weeks a month is drawn in — 35 or 42 days, Monday first.
 *
 * Weeks rather than the month alone, because a grid of seven columns has to
 * begin on a Monday: a February that starts on a Sunday would otherwise put its
 * 1st under «пн». The days either side belong to the neighbouring months and
 * are drawn quieter, but they are real dates and pressing one works — the last
 * days of the outgoing month are exactly what somebody looking at the 1st is
 * most likely to want next.
 */
export function monthGrid(anchor: LocalDate): LocalDate[] {
  const first: LocalDate = { year: anchor.year, month: anchor.month, day: 1 };
  const start = addLocalDays(first, 1 - localDateWeekday(first));

  const nextMonth: LocalDate =
    anchor.month === 12
      ? { year: anchor.year + 1, month: 1, day: 1 }
      : { year: anchor.year, month: anchor.month + 1, day: 1 };
  const last = addLocalDays(nextMonth, -1);
  const end = formatLocalDate(addLocalDays(last, 7 - localDateWeekday(last)));

  const days: LocalDate[] = [];
  for (let cursor = start; ; cursor = addLocalDays(cursor, 1)) {
    days.push(cursor);
    if (formatLocalDate(cursor) === end) return days;
  }
}

/**
 * What the calendar shows at a moment, in a zone: today, the day selected, the
 * month grid around it, and the window of instants read for that grid.
 *
 * A date in the address wins; without one, the day selected is today in
 * `zone`. The window runs a day either side of the grid, because it is
 * expressed in UTC and the studio's addresses need not share a zone: the
 * filtering back to exact local days happens once each row's own zone is known.
 */
export function calendarFrame(now: Date, zone: string, date?: string) {
  const todayParts = toZonedParts(now, zone);
  const today: LocalDate = { year: todayParts.year, month: todayParts.month, day: todayParts.day };
  const anchor = (date ? parseLocalDate(date) : null) ?? today;
  const grid = monthGrid(anchor);
  return {
    today,
    anchor,
    grid,
    selected: formatLocalDate(anchor),
    windowStart: new Date(Date.UTC(grid[0].year, grid[0].month - 1, grid[0].day - 1)),
    windowEnd: new Date(Date.UTC(grid.at(-1)!.year, grid.at(-1)!.month - 1, grid.at(-1)!.day + 2)),
  };
}

export type CalendarFrame = ReturnType<typeof calendarFrame>;

/**
 * Whether what was read for one frame serves another: the same day selected
 * and the same month drawn. «Today» itself may differ — it is only a mark on
 * the grid, computed again from the true zone — but the rows read are the
 * window's and the day's, and those must match.
 */
export function sameWindow(read: CalendarFrame, wanted: CalendarFrame): boolean {
  return read.selected === wanted.selected && read.windowStart.getTime() === wanted.windowStart.getTime();
}
