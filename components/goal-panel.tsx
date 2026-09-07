import Link from "next/link";

/**
 * One goal and one button.
 *
 * The shape both guided screens share — the first run on `/app` and the month's
 * own setup below the report — because they make the same promise in different
 * places: a figure the studio cannot read yet, and the single thing that would
 * make it readable.
 *
 * Nothing else is on it. A folded list of what else is outstanding, a way to
 * skip the whole thing, a line of stakes above the goal and a hint below it
 * were all tried here and all removed: this panel asks for one thing, and every
 * extra line on it is an invitation to do something other than that one thing.
 */
export function GoalPanel({
  eyebrow,
  goal,
  action,
  href,
  remaining,
  back,
}: {
  /**
   * Optional, and the month's panel passes none. «Расчёт месяца» over «Внесите
   * постоянные затраты» named the section a goal already belongs to; the first
   * run keeps its eyebrow because there it is the screen's only heading.
   */
  eyebrow?: string;
  goal: string;
  action: string;
  href: string;
  /** «Осталось 2 шага» — the size of what is left, without listing it. */
  remaining: string;
  /**
   * The step before this one, when there is one: a way back to work already
   * done — a price typed wrong, a second master to add — without leaving the
   * guided run to find it. Null on the first step, where back is the way out
   * rather than a step.
   */
  back?: Readonly<{ label: string; href: string }> | null;
}) {
  return (
    <section className="panel goal-panel" aria-labelledby="goal-panel-title">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}

      <h2 id="goal-panel-title" className="goal-panel-goal">
        {goal}
      </h2>

      <div className="button-row">
        <Link className="primary-button" href={href}>
          {action}
        </Link>
      </div>

      <p className="goal-panel-remaining">
        {remaining}
        {back && (
          <>
            {" · "}
            <Link className="text-link" href={back.href}>
              {back.label}
            </Link>
          </>
        )}
      </p>
    </section>
  );
}
