import Link from "next/link";

/**
 * One goal, the reason it matters, and one button.
 *
 * The shape both guided screens share — the first run on `/app` and the month's
 * own setup below the report — because they make the same promise in different
 * places: a figure the studio cannot read yet, and the single thing that would
 * make it readable.
 *
 * Nothing else is on it. A folded list of what else is outstanding, and a way to
 * skip the whole thing, were both tried here and both removed: this panel asks
 * for one thing, and every extra line on it is an invitation to do something
 * other than that one thing.
 */
export function GoalPanel({
  eyebrow,
  lead,
  goal,
  hint,
  action,
  href,
  remaining,
  back,
}: {
  eyebrow: string;
  /**
   * Optional, and the first run passes neither. A screen that says «три
   * коротких шага» above a goal that already names the step is explaining the
   * explanation; the month's panel keeps its line, because there the stakes —
   * a report that reads higher than the truth — are not visible from the goal.
   */
  lead?: string;
  goal: string;
  hint?: string;
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
      <span className="eyebrow">{eyebrow}</span>
      {lead && <p className="goal-panel-lead">{lead}</p>}

      <h2 id="goal-panel-title" className="goal-panel-goal">
        {goal}
      </h2>
      {hint && <p className="goal-panel-hint">{hint}</p>}

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
