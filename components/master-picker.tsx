"use client";

/**
 * Whom to book: round photos in one row, the name under each.
 *
 * Shared by the public booking page and the calendar's «Новая запись», because
 * a master is chosen the same way in both: by their face, in one tap, with the
 * choices on screen before the choice is made. The radio inside each label is
 * the control and the circle only shows which one it is, so the group is a
 * real radio group to a keyboard and a screen reader, and it is read from
 * `FormData` under `name` by a form that wants it there.
 */

export type MasterFace = Readonly<{
  id: string;
  name: string;
  /** A photo URL; null draws the first letter of the name. */
  avatar: string | null;
}>;

export function MasterPicker({
  legend,
  name,
  people,
  value,
  onChange,
  disabled = false,
}: {
  legend: string;
  name: string;
  people: readonly MasterFace[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="master-picker" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="master-picker-row">
        {people.map((person) => (
          <label key={person.id} className="master-picker-item">
            <input
              type="radio"
              name={name}
              className="sr-only"
              value={person.id}
              checked={person.id === value}
              onChange={() => onChange(person.id)}
            />
            <span className="avatar" aria-hidden="true">
              {person.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element -- a studio's own photo, not a build-time asset.
                <img src={person.avatar} alt="" loading="lazy" />
              ) : (
                person.name.trim().slice(0, 1).toUpperCase() || "?"
              )}
            </span>
            <span className="master-picker-name">{person.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
