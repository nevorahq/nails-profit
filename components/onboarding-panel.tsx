import Link from "next/link";

import { GoalPanel } from "@/components/goal-panel";
import type { ChecklistProgress } from "@/lib/onboarding";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * The path to a first number, roadmap phase 4 "onboarding progress".
 *
 * Every step is linked, not just the next one — an owner who already knows the
 * piece they are missing should not be walked through a wizard to reach it. The
 * list is a map of what is missing, not a gate.
 *
 * What the map was missing is where to put a foot next. The first unfinished
 * step is singled out by a moving arrow and one line saying what it will make
 * the report able to state — the step alone names a thing to enter, not a
 * reason to enter it, and «Постоянные затраты месяца» reads as bookkeeping
 * until you know the month's profit is overstated without them.
 *
 * Only that step carries its line. A hint under every row would turn a list
 * that can be read at a glance into a page of advice.
 *
 * A server component: nothing here reacts to anything, so the dashboard pays
 * for no JavaScript bundle to render it.
 */
function ChecklistPanel<Key extends string>({
  progress,
  locale,
  prefix,
}: {
  progress: ChecklistProgress<Key>;
  locale: AppLocale;
  /** Which family of strings names the steps: `<prefix>.<step key>`. */
  prefix: "onboarding" | "monthSetup";
}) {
  const t = getTranslator(locale);
  const label = (step: string) => t(`${prefix}.${step}` as MessageKey);

  return (
    <section className="panel">
      <h2>{t(`${prefix}.title` as MessageKey)}</h2>
      <p className="muted">
        {t(`${prefix}.progress` as MessageKey, { done: progress.done, total: progress.total })}
      </p>

      <ol className="compact-list">
        {progress.steps.map((step) => {
          const isNext = progress.next?.key === step.key;

          return (
            <li key={step.key} className={step.done ? "muted" : undefined}>
              {/*
                The one thing on the panel that moves, and it moves at the step
                to start with. Decoration, not information: the ✓/○/→ is
                `aria-hidden` and the state a reader is told is the link or the
                plain text beside it.
              */}
              <span aria-hidden="true" className={isNext ? "checklist-arrow" : undefined}>{step.done ? "✓" : isNext ? "→" : "○"}</span>{" "}
              {step.done ? (
                label(step.key)
              ) : (
                <Link className="text-link" href={step.href}>
                  {label(step.key)}
                </Link>
              )}
              {isNext && <span className="checklist-hint">{label(`${step.key}Hint`)}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function OnboardingPanel({
  progress,
  locale,
}: {
  progress: ChecklistProgress<"specialist" | "service" | "visit">;
  locale: AppLocale;
}) {
  return <ChecklistPanel progress={progress} locale={locale} prefix="onboarding" />;
}

/**
 * The month's own setup, shown only once the first run is finished.
 *
 * Built as one goal rather than as a list, exactly like the first run — the
 * same promise made in a different place. Two ○ under a heading called «Расчёт
 * месяца» read as a second helping of homework arriving the moment the first
 * one was cleared; one goal with the reason under it reads as the next move,
 * and the reason is the part that was missing: «Постоянные затраты месяца» is
 * bookkeeping until somebody says the profit above is overstated without them.
 *
 * Null when there is nothing left to point at. The dashboard already declines
 * to render a finished checklist, so this is a guard rather than a state
 * anybody reaches.
 */
export function MonthSetupPanel({
  progress,
  locale,
}: {
  progress: ChecklistProgress<"overhead" | "rota">;
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const next = progress.next;
  if (!next) return null;

  const index = progress.steps.findIndex((step) => step.key === next.key);
  const previous = index > 0 ? progress.steps[index - 1] : null;

  return (
    <GoalPanel
      eyebrow={t("monthSetup.title")}
      lead={t("monthSetup.lead")}
      goal={t(`step.goal.${next.key}` as MessageKey)}
      hint={t(`monthSetup.${next.key}Hint` as MessageKey)}
      action={t(`step.action.${next.key}` as MessageKey)}
      href={next.href}
      remaining={t("step.remaining", { count: progress.total - progress.done })}
      back={
        previous && {
          label: t("step.back", { step: t(`monthSetup.${previous.key}` as MessageKey) }),
          href: previous.href,
        }
      }
    />
  );
}
