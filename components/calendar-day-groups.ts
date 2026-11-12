/**
 * The listed day, cut into one run per master.
 *
 * A studio reading «all masters» used to get one queue in clock order with a
 * name on every card, free ones included — the same name three times in a row
 * for a master with three open hours. Grouped, the name heads the run once and
 * the cards underneath say only what is booked or open.
 *
 * In the studio's own order of its masters (the one the public page uses),
 * each run keeping the clock order it was given. Somebody who is no longer on
 * the roster but still has something on the day — an archived master's past
 * appointment — follows the roster, in the order they first appear, so their
 * entries are not lost. A master with nothing on the day has no run: a header
 * over an empty list is a line that says nothing.
 */
export type DayGroup<Item> = Readonly<{
  specialistId: string;
  items: Item[];
}>;

export function groupDayByMaster<Item>(
  items: readonly Item[],
  specialistOf: (item: Item) => string,
  roster: readonly string[],
): DayGroup<Item>[] {
  const runs = new Map<string, Item[]>();
  for (const item of items) {
    const id = specialistOf(item);
    const run = runs.get(id);
    if (run) run.push(item);
    else runs.set(id, [item]);
  }

  const known = roster.filter((id) => runs.has(id));
  const strangers = [...runs.keys()].filter((id) => !roster.includes(id));
  return [...known, ...strangers].map((specialistId) => ({
    specialistId,
    items: runs.get(specialistId) ?? [],
  }));
}
