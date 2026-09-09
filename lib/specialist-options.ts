/**
 * The people a picker must offer so that leaving it alone changes nothing.
 *
 * A `<select>` whose value matches none of its options does not stay unset: the
 * browser selects the first option and reports its value, so a form submitted
 * without touching that field silently answers with somebody else. On the
 * calendar that meant a reschedule which only moved the time also moved the
 * appointment to whoever headed the list — reachable whenever the master was
 * archived, because appointments are deliberately not filtered by the archive
 * and the roster deliberately is.
 *
 * Written here rather than inline so the rule can be stated once and tested:
 * whoever the row already names is always among the options, whether or not
 * they still work here.
 */
export type PickableSpecialist = Readonly<{ id: string; name: string }>;

export function specialistOptions(
  /** Everyone this caller may assign work to, already narrowed by role. */
  assignable: readonly PickableSpecialist[],
  /** The person the row names now, and the name to show if they are gone. */
  current: Readonly<{ id: string; name: string }>,
): readonly (PickableSpecialist & { archived: boolean })[] {
  const live = assignable.map((person) => ({ ...person, archived: false }));
  if (live.some((person) => person.id === current.id)) return live;
  // First, not appended: it is the selected one, and a list whose selected
  // entry is at the bottom reads as a list somebody has already changed.
  return [{ id: current.id, name: current.name, archived: true }, ...live];
}
