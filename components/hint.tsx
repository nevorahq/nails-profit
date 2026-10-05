import Link from "next/link";

/**
 * A hint in one line, and the rest of it one press away.
 *
 * The hints on the money screens grew into paragraphs, each correct and each
 * read by nobody: a solo master looking for what is left this month met three
 * sentences about accrual accounting under the table. The first line now says
 * what the figure is; «Подробнее» keeps the whole explanation word for word,
 * and ends on the one worked example every hint refers to (`/app/how`), so the
 * same arithmetic is not re-explained seven different ways.
 *
 * Takes strings rather than keys so that it renders the same in a server page
 * and inside a client form: whoever renders it has already chosen the words
 * for its reader. A `<div>`, not a `<p>` — a `<details>` cannot live in a
 * paragraph, and not inside a `<label>` either, where its summary would toggle
 * the field.
 */
export function Hint({
  short,
  more,
  moreLabel,
  howLabel,
  className = "muted",
}: {
  short: string;
  more: string;
  /** «Подробнее». */
  moreLabel: string;
  /** The link to the worked example. */
  howLabel: string;
  className?: string;
}) {
  return (
    <div className={`hint ${className}`}>
      <span>{short}</span>
      <details className="hint-more">
        <summary>{moreLabel}</summary>
        <p>{more}</p>
        <Link className="text-link" href="/app/how">
          {howLabel}
        </Link>
      </details>
    </div>
  );
}
